import threading

import numpy as np

from claudevoice.config import Config
from claudevoice.engine import Speaker


class FakeSynthesizer:
    def __init__(self, fail_on: str | None = None):
        self.spoken: list[str] = []
        self.voices: list[tuple[str, str]] = []
        self.fail_on = fail_on

    async def create_stream(self, text, voice, speed, lang, trim=True):
        if text == self.fail_on:
            raise ValueError("nothing to synthesize")
        self.spoken.append(text)
        self.voices.append((voice, lang))
        yield np.ones(10, dtype=np.float32), 24000


class FakePlayer:
    def __init__(self, holds: bool):
        self.audio: list[np.ndarray] = []
        self.is_finished = False
        self.is_closed = False
        self.started_waiting = threading.Event()
        self._released = threading.Event()
        if not holds:
            self._released.set()

    def add(self, audio):
        self.audio.append(audio)

    def finish(self):
        self.is_finished = True

    def wait(self):
        self.started_waiting.set()
        self._released.wait()

    def close(self):
        self.is_closed = True
        self._released.set()


class Players:
    def __init__(self, holds: bool = False):
        self.holds = holds
        self.made: list[FakePlayer] = []
        self._changed = threading.Condition()

    def __call__(self, sample_rate):
        player = FakePlayer(self.holds)
        with self._changed:
            self.made.append(player)
            self._changed.notify_all()
        return player

    def playing(self, count: int = 1) -> bool:
        with self._changed:
            if not self._changed.wait_for(lambda: len(self.made) >= count, timeout=5):
                return False
        return self.made[count - 1].started_waiting.wait(5)


def make_speaker(holds: bool = False, synthesizer: FakeSynthesizer | None = None):
    players = Players(holds)
    synthesizer = synthesizer or FakeSynthesizer()
    return Speaker(synthesizer, Config(), players), players, synthesizer
