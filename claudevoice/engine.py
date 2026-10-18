import asyncio
import contextlib
import itertools
import logging
import re
import threading
from collections import OrderedDict, deque
from collections.abc import Iterable
from concurrent.futures import Future, ThreadPoolExecutor
from concurrent.futures import TimeoutError as WaitTimeout
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
    def add(self, audio: np.ndarray, piece: int) -> None: ...
    def heard(self) -> int | None: ...
    def finish(self) -> None: ...
    def wait(self) -> None: ...
    def close(self) -> None: ...


class SoundDevicePlayer:
    """Plays chunks through one output stream as they arrive, with silence while waiting for the next one."""

    def __init__(self, sample_rate: int):
        import sounddevice

        self._sd = sounddevice
        self._rate = sample_rate
        self._chunks: deque[tuple[np.ndarray, int]] = deque()
        self._position = 0
        self._timeline = 0
        self._marks: deque[tuple[int, int]] = deque()
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
                chunk, piece = self._chunks[0]
                if self._position == 0:
                    self._marks.append((self._timeline + written, piece))
                take = min(frames - written, len(chunk) - self._position)
                outdata[written : written + take, 0] = chunk[self._position : self._position + take]
                written += take
                self._position += take
                if self._position == len(chunk):
                    self._chunks.popleft()
                    self._position = 0
            self._timeline += frames
            self._trim_marks()
            is_done = self._is_finishing and not self._chunks
        outdata[written:] = 0
        if is_done:
            raise self._sd.CallbackStop

    def add(self, audio: np.ndarray, piece: int) -> None:
        with self._lock:
            self._chunks.append((np.asarray(audio, dtype=np.float32).ravel(), piece))

    def _heard_frame(self) -> int:
        return self._timeline - int(self._stream.latency * self._rate)

    def _trim_marks(self) -> None:
        heard = self._heard_frame()
        while len(self._marks) > 1 and self._marks[1][0] < heard:
            self._marks.popleft()

    def heard(self) -> int | None:
        with self._lock:
            heard = self._heard_frame()
            if not self._marks or self._marks[0][0] >= heard:
                return None
            return self._marks[0][1]

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
    after: frozenset = frozenset()
    is_queued: bool = False
    resume_at: int = 0
    played: datetime | None = None
    task: asyncio.Task | None = None
    sound: asyncio.Task | None = None
    settled: bool = False


class Speaker:
    """Speaks one text at a time. A new text cuts off everything playing or waiting, unless it is queued to follow them or, with after_own, only waits for its own owner's speech. A paused owner's speech is set aside: other owners neither cut it off nor wait for it, but its own owner's Stop and replacing speech cut it off, while its owner's later queued or after_own speech only waits behind it."""

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
        self._paused: set[str] = set()
        self._changed = asyncio.Event()
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
        paused: bool | None = None,
    ) -> int:
        """Starts speaking. `queue` waits for everything already playing; `after_own` cuts off other owners but waits for the owner's own. `paused` sets or clears the owner's pause first; None leaves it, except that replacing speech clears it."""
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
        asyncio.run_coroutine_threadsafe(self._start(playing, queue, after_own, paused, done), self._loop).result()
        return job

    def stop(self, owner: str | None = None, job: int | None = None) -> None:
        asyncio.run_coroutine_threadsafe(self._stop(owner, job), self._loop).result()

    async def _stop(self, owner: str | None, job: int | None) -> None:
        async with self._starting:
            if job is None:
                if owner is None:
                    self._paused.clear()
                else:
                    self._paused.discard(owner)
            await self._cancel(lambda p: (owner is None or p.owner == owner) and (job is None or p.job == job))

    def pause(self, owner: str) -> None:
        """Sets the owner's speech aside; it starts again from the beginning of the sentence it was in."""
        asyncio.run_coroutine_threadsafe(self._pause(owner), self._loop).result()

    async def _pause(self, owner: str) -> None:
        async with self._starting:
            if not any(p.owner == owner for p in self._playing):
                return
            self._paused.add(owner)
            for playing in self._playing:
                if playing.owner == owner and playing.sound is not None:
                    playing.sound.cancel()
            self._wake()

    def resume(self, owner: str) -> None:
        """Lets the owner's speech carry on, cutting off other owners' speech as after_own does."""
        asyncio.run_coroutine_threadsafe(self._resume(owner), self._loop).result()

    async def _resume(self, owner: str) -> None:
        async with self._starting:
            if owner not in self._paused:
                return
            self._paused.discard(owner)
            if any(p.owner == owner for p in self._playing):
                await self._cancel(lambda p: p.owner != owner and p.owner not in self._paused)
            self._wake()

    def wait(self, job: int, hold: float | None = None) -> dict:
        """The job's result, or "waiting" if it has not ended within `hold` seconds."""
        with self._lock:
            done = self._jobs.get(job)
        if done is None:
            return {"job": job, "result": "unknown"}
        try:
            return done.result(timeout=hold)
        except WaitTimeout:
            return {"job": job, "result": "waiting"}

    def is_speaking(self) -> bool:
        return any(playing.sound is not None and not playing.sound.done() for playing in list(self._playing))

    def is_paused(self, owner: str) -> bool:
        return owner in self._paused

    def close(self) -> None:
        self.stop()
        self._loop.call_soon_threadsafe(self._loop.stop)
        self._thread.join()
        self._log_writer.shutdown(wait=True)

    async def _cancel(self, chosen: Callable[[_Playing], bool]) -> None:
        targets = [p.task for p in self._playing if chosen(p)]
        for task in targets:
            task.cancel()
        for task in targets:
            with contextlib.suppress(asyncio.CancelledError):
                await task

    async def _start(self, playing: _Playing, queue: bool, after_own: bool, paused: bool | None, done: Future) -> None:
        async with self._starting:
            if not playing.spoken:
                self._settle(playing, done, {"job": playing.job, "result": "nothing"})
                return
            if paused is True:
                self._paused.add(playing.owner)
            elif paused is False:
                was_paused = playing.owner in self._paused
                self._paused.discard(playing.owner)
                if was_paused and any(p.owner == playing.owner for p in self._playing):
                    await self._cancel(lambda p: p.owner != playing.owner and p.owner not in self._paused)
                self._wake()
            is_paused = playing.owner in self._paused
            if after_own:
                if not is_paused:
                    await self._cancel(lambda p: p.owner != playing.owner and p.owner not in self._paused)
                playing.after = frozenset(p for p in self._playing if p.owner == playing.owner)
            elif queue:
                playing.after = frozenset(self._playing)
                playing.is_queued = True
            else:
                if paused is None:
                    self._paused.discard(playing.owner)
                    is_paused = False
                await self._cancel(lambda p: p.owner == playing.owner or (not is_paused and p.owner not in self._paused))
                if paused is True:
                    self._paused.add(playing.owner)
            playing.task = self._loop.create_task(self._run(done, playing))
            task = playing.task
            self._playing.append(playing)
            task.add_done_callback(lambda _: self._ended(playing, done))

    def _ended(self, playing: _Playing, done: Future) -> None:
        if playing in self._playing:
            self._playing.remove(playing)
        if not any(p.owner == playing.owner for p in self._playing):
            self._paused.discard(playing.owner)
        self._settle(playing, done, {"job": playing.job, "result": "stopped"})
        self._wake()

    def _wake(self) -> None:
        changed, self._changed = self._changed, asyncio.Event()
        changed.set()

    def _may_play(self, playing: _Playing) -> bool:
        if playing.owner in self._paused:
            return False
        return all(p.task.done() or (playing.is_queued and p.owner in self._paused) for p in playing.after)

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

    async def _run(self, done: Future, playing: _Playing) -> None:
        job = playing.job
        try:
            while True:
                while not self._may_play(playing):
                    await self._changed.wait()
                if playing.played is None:
                    playing.played = now()
                if await self._play(playing):
                    break
                log.info("job %d: paused before piece %d", job, playing.resume_at)
        except asyncio.CancelledError:
            log.info("job %d: stopped", job)
            raise
        except Exception as error:
            log.exception("job %d: failed", job)
            self._settle(playing, done, {"job": job, "result": "error", "error": str(error)})
        else:
            log.info("job %d: finished", job)
            self._settle(playing, done, {"job": job, "result": "finished"})

    async def _play(self, playing: _Playing) -> bool:
        """Plays from `resume_at`; False when a pause cut it short."""
        sound = self._loop.create_task(self._sound(playing))
        playing.sound = sound
        try:
            await asyncio.wait({sound})
        except asyncio.CancelledError:
            sound.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await sound
            raise
        finally:
            playing.sound = None
        if sound.cancelled():
            return False
        sound.result()
        return True

    async def _sound(self, playing: _Playing) -> None:
        job, voice, start = playing.job, playing.voice, playing.resume_at
        spoken = pieces(playing.spoken)
        player = self._player_factory(SAMPLE_RATE)
        try:
            for index, (piece, pause) in enumerate(spoken[start:], start):
                stream = self._synthesizer.create_stream(
                    piece, voice=voice, speed=self._config.speed, lang=language_of(voice), trim=False
                )
                try:
                    async for audio, _ in stream:
                        player.add(tidy(audio), index)
                except ValueError as error:
                    log.warning("job %d: skipped a piece that could not be spoken: %s", job, error)
                if pause:
                    player.add(np.zeros(int(pause * SAMPLE_RATE), dtype=np.float32), index)
            player.add(np.zeros(int(END_SILENCE * SAMPLE_RATE), dtype=np.float32), max(len(spoken) - 1, 0))
            player.finish()
            await self._loop.run_in_executor(None, player.wait)
        except asyncio.CancelledError:
            heard = player.heard()
            playing.resume_at = start if heard is None else heard
            raise
        finally:
            player.close()


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

