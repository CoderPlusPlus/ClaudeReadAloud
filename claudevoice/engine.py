import asyncio
import contextlib
import itertools
import logging
import re
import threading
from collections import OrderedDict, deque
from collections.abc import Iterable
from concurrent.futures import Future, ThreadPoolExecutor
from dataclasses import dataclass
from datetime import datetime
from typing import Any, AsyncIterator, Callable, Protocol

import numpy as np

from .config import Config, language_of
from .spoken import SpokenLog, now, stamp
from .text import to_speech

SAMPLE_RATE = 24000
SENTENCE_PAUSE = 0.25
PARAGRAPH_PAUSE = 0.45
END_SILENCE = 0.2
# Kokoro's own trimming clipped the end of words like "sender" with some voices, so speech is trimmed here instead.
QUIET_LEVEL = 0.01
LEAD_KEPT = 0.02
TAIL_KEPT = 0.12
_KEPT_JOBS = 16
_SENTENCE_END = re.compile(r"(?<=[.!?])\s+")
_ABBREVIATION = re.compile(r"(?:[a-z]\.)+[a-z]|v[0-9]+|dr|mr|mrs|ms|prof|sr|jr|st|vs|cf|inc|ltd", re.IGNORECASE)
_LEADING_MARKS = "(\"'`["

log = logging.getLogger(__name__)


class Synthesizer(Protocol):
    def create_stream(
        self, text: str, voice: str, speed: float, lang: str, trim: bool
    ) -> AsyncIterator[tuple[np.ndarray, int]]: ...


class Player(Protocol):
    def add(self, audio: np.ndarray) -> None: ...
    def finish(self) -> None: ...
    def wait(self) -> None: ...
    def close(self) -> None: ...


class SoundDevicePlayer:
    """Plays chunks through one output stream as they arrive, with silence while waiting for the next one."""

    def __init__(self, sample_rate: int):
        import sounddevice

        self._sd = sounddevice
        self._chunks: deque[np.ndarray] = deque()
        self._position = 0
        self._is_finishing = False
        self._lock = threading.Lock()
        self._ended = threading.Event()
        self._stream = sounddevice.OutputStream(
            samplerate=sample_rate,
            channels=1,
            dtype="float32",
            callback=self._fill,
            finished_callback=self._ended.set,
        )
        self._stream.start()

    def _fill(self, outdata: np.ndarray, frames: int, _time: Any, _status: Any) -> None:
        written = 0
        with self._lock:
            while written < frames and self._chunks:
                chunk = self._chunks[0]
                take = min(frames - written, len(chunk) - self._position)
                outdata[written : written + take, 0] = chunk[self._position : self._position + take]
                written += take
                self._position += take
                if self._position == len(chunk):
                    self._chunks.popleft()
                    self._position = 0
            is_done = self._is_finishing and not self._chunks
        outdata[written:] = 0
        if is_done:
            raise self._sd.CallbackStop

    def add(self, audio: np.ndarray) -> None:
        with self._lock:
            self._chunks.append(np.asarray(audio, dtype=np.float32).ravel())

    def finish(self) -> None:
        with self._lock:
            self._is_finishing = True

    def wait(self) -> None:
        self._ended.wait()

    def close(self) -> None:
        if not self._ended.is_set():
            self._stream.abort()
        self._stream.close()


@dataclass(eq=False)
class _Playing:
    job: int
    owner: str
    voice: str
    spoken: str
    record: dict | None
    requested: datetime
    played: datetime | None = None
    task: asyncio.Task | None = None
    settled: bool = False


class Speaker:
    """Speaks one text at a time. A new text cuts off everything playing or waiting, unless it is queued to follow them or, with after_own, only waits for its own owner's speech."""

    def __init__(
        self,
        synthesizer: Synthesizer,
        config: Config,
        player_factory: Callable[[int], Player] = SoundDevicePlayer,
        voices: Iterable[str] | None = None,
        spoken_log: SpokenLog | None = None,
    ):
        self._synthesizer = synthesizer
        self._spoken_log = spoken_log
        self._log_writer = ThreadPoolExecutor(max_workers=1, thread_name_prefix="spoken-log")
        self._config = config
        self._player_factory = player_factory
        self._voices = None if voices is None else frozenset(voices)
        self._ids = itertools.count(1)
        self._jobs: OrderedDict[int, Future] = OrderedDict()
        self._lock = threading.Lock()
        self._playing: list[_Playing] = []
        self._starting = asyncio.Lock()
        self._loop = asyncio.new_event_loop()
        self._thread = threading.Thread(target=self._loop.run_forever, name="speaker", daemon=True)
        self._thread.start()

    def knows_voice(self, voice: str) -> bool:
        try:
            language_of(voice)
        except ValueError:
            return False
        return self._voices is None or voice in self._voices

    def speak(
        self,
        markdown: str,
        voice: str | None = None,
        owner: str = "",
        queue: bool = False,
        after_own: bool = False,
        record: dict | None = None,
    ) -> int:
        """Starts speaking. `queue` waits for everything already playing; `after_own` cuts off other owners but waits for the owner's own."""
        if queue and after_own:
            raise ValueError("queue and after_own cannot both be set")
        if after_own and not owner:
            raise ValueError("after_own needs an owner")
        voice = voice or self._config.voice
        if not self.knows_voice(voice):
            raise ValueError(f"unknown voice {voice!r}")
        requested = now()
        spoken = to_speech(markdown)
        done: Future = Future()
        with self._lock:
            job = next(self._ids)
            self._jobs[job] = done
            for old in [j for j, f in self._jobs.items() if f.done()][: max(0, len(self._jobs) - _KEPT_JOBS)]:
                del self._jobs[old]
        log.info("job %d: %d characters to speak with %s", job, len(spoken), voice)
        playing = _Playing(job, owner, voice, spoken, record, requested)
        asyncio.run_coroutine_threadsafe(self._start(playing, queue, after_own, done), self._loop).result()
        return job

    def stop(self, owner: str | None = None, job: int | None = None) -> None:
        asyncio.run_coroutine_threadsafe(self._stop(owner, job), self._loop).result()

    async def _stop(self, owner: str | None, job: int | None) -> None:
        async with self._starting:
            await self._cancel(owner, job=job)

    def wait(self, job: int) -> dict:
        with self._lock:
            done = self._jobs.get(job)
        if done is None:
            return {"job": job, "result": "unknown"}
        return done.result()

    def is_speaking(self) -> bool:
        return any(playing.played is not None and not playing.task.done() for playing in list(self._playing))

    def close(self) -> None:
        self.stop()
        self._loop.call_soon_threadsafe(self._loop.stop)
        self._thread.join()
        self._log_writer.shutdown(wait=True)

    async def _cancel(self, owner: str | None = None, keep: str | None = None, job: int | None = None) -> None:
        targets = [
            p.task
            for p in self._playing
            if (owner is None or p.owner == owner) and (job is None or p.job == job) and p.owner != keep
        ]
        for task in targets:
            task.cancel()
        for task in targets:
            with contextlib.suppress(asyncio.CancelledError):
                await task

    async def _start(self, playing: _Playing, queue: bool, after_own: bool, done: Future) -> None:
        async with self._starting:
            if not playing.spoken:
                self._settle(playing, done, {"job": playing.job, "result": "nothing"})
                return
            if after_own:
                await self._cancel(keep=playing.owner)
                before = {p.task for p in self._playing if p.owner == playing.owner}
            elif queue:
                before = {p.task for p in self._playing}
            else:
                await self._cancel()
                before = set()
            playing.task = self._loop.create_task(self._run(done, before, playing))
            task = playing.task
            self._playing.append(playing)
            task.add_done_callback(lambda _: self._ended(playing, done))

    def _ended(self, playing: _Playing, done: Future) -> None:
        if playing in self._playing:
            self._playing.remove(playing)
        self._settle(playing, done, {"job": playing.job, "result": "stopped"})

    def _settle(self, playing: _Playing, done: Future, result: dict) -> None:
        if playing.settled:
            return
        playing.settled = True
        if self._spoken_log is None:
            done.set_result(result)
            return
        ended = now()
        line = {
            "start": stamp(playing.requested),
            "played": None if playing.played is None else stamp(playing.played),
            "end": stamp(ended),
            **result,
            "owner": playing.owner,
            "voice": playing.voice,
            "text": playing.spoken,
            "record": playing.record,
        }
        try:
            self._log_writer.submit(self._write_log, playing.job, line, ended).add_done_callback(lambda _: done.set_result(result))
        except RuntimeError:
            log.exception("job %d: could not add it to the spoken log", playing.job)
            done.set_result(result)

    def _write_log(self, job: int, line: dict, ended: datetime) -> None:
        try:
            self._spoken_log.write(line, ended)
        except Exception:
            log.exception("job %d: could not add it to the spoken log", job)

    async def _run(self, done: Future, before: set, playing: _Playing) -> None:
        job, spoken, voice = playing.job, playing.spoken, playing.voice
        try:
            if before:
                await asyncio.wait(before)
            playing.played = now()
            player = self._player_factory(SAMPLE_RATE)
            try:
                for piece, pause in pieces(spoken):
                    stream = self._synthesizer.create_stream(
                        piece, voice=voice, speed=self._config.speed, lang=language_of(voice), trim=False
                    )
                    try:
                        async for audio, _ in stream:
                            player.add(tidy(audio))
                    except ValueError as error:
                        log.warning("job %d: skipped a piece that could not be spoken: %s", job, error)
                    if pause:
                        player.add(np.zeros(int(pause * SAMPLE_RATE), dtype=np.float32))
                player.add(np.zeros(int(END_SILENCE * SAMPLE_RATE), dtype=np.float32))
                player.finish()
                await self._loop.run_in_executor(None, player.wait)
            finally:
                player.close()
        except asyncio.CancelledError:
            log.info("job %d: stopped", job)
            raise
        except Exception as error:
            log.exception("job %d: failed", job)
            self._settle(playing, done, {"job": job, "result": "error", "error": str(error)})
        else:
            log.info("job %d: finished", job)
            self._settle(playing, done, {"job": job, "result": "finished"})


def tidy(audio: np.ndarray) -> np.ndarray:
    """Cuts the silence around the sound, keeping a short tail so soft final sounds like a closing "r" are not clipped."""
    level = np.abs(audio)
    if not len(level) or not level.max():
        return audio[:0]
    loud = np.flatnonzero(level > QUIET_LEVEL * level.max())
    start = max(0, loud[0] - int(LEAD_KEPT * SAMPLE_RATE))
    end = min(len(audio), loud[-1] + 1 + int(TAIL_KEPT * SAMPLE_RATE))
    return audio[start:end]


def pieces(spoken: str) -> list[tuple[str, float]]:
    """Splits text into sentences so the first one can play while the rest are made, each with the pause after it."""
    result = []
    for line in spoken.splitlines():
        sentences = _sentences(line.strip())
        result += [(s, SENTENCE_PAUSE) for s in sentences[:-1]]
        if sentences:
            result.append((sentences[-1], PARAGRAPH_PAUSE))
    if result:
        result[-1] = (result[-1][0], 0.0)
    return result


def _is_abbreviation(word: str) -> bool:
    core = word.lstrip(_LEADING_MARKS)
    if not core.endswith("."):
        return False
    core = core[:-1]
    return (len(core) == 1 and core.isupper()) or _ABBREVIATION.fullmatch(core) is not None


def _sentences(line: str) -> list[str]:
    result = []
    start = 0
    for end in _SENTENCE_END.finditer(line):
        words = line[start : end.start()].split()
        if words and _is_abbreviation(words[-1]):
            continue
        result.append(line[start : end.start()])
        start = end.end()
    result.append(line[start:])
    return [sentence for sentence in result if sentence]

