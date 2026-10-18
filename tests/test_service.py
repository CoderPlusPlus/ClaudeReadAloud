import sys
import threading
import time

import pytest

from claudevoice import service
from claudevoice.config import Config
from claudevoice.server import SpeakerServer
from tests.fakes import make_speaker


def _free_port() -> int:
    server = SpeakerServer(0)
    port = server.server_address[1]
    server.server_close()
    return port


def _stub(line: str | None) -> list[str]:
    script = "import time; time.sleep(30)" if line is None else f"print({line!r}, flush=True)"
    return [sys.executable, "-c", script]


@pytest.mark.parametrize("line", [service.READY, service.RUNNING])
def test_start_succeeds_when_the_speaker_says_it_is_up(capsys, line):
    assert service.start(Config(port=_free_port()), _stub(line)) == 0
    assert capsys.readouterr().out.strip() == line


def test_start_reports_why_the_speaker_failed(capsys):
    assert service.start(Config(port=_free_port()), _stub("could not load the voice model: boom")) == 1
    assert "boom" in capsys.readouterr().out


def test_start_reports_a_speaker_that_exits_silently(capsys):
    assert service.start(Config(port=_free_port()), [sys.executable, "-c", "pass"]) == 1
    assert "stopped while starting" in capsys.readouterr().out


def test_start_gives_up_after_the_wait(capsys):
    assert service.start(Config(port=_free_port()), _stub(None), wait_seconds=1) == 1
    assert "did not start within 1 seconds" in capsys.readouterr().out


def test_start_and_stop_with_one_already_running(capsys):
    speaker, _, _ = make_speaker()
    server = SpeakerServer(0, speaker)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    config = Config(port=server.server_address[1])
    try:
        assert service.is_running(config.port)
        assert service.start(config, _stub("should not run")) == 0
        assert capsys.readouterr().out.strip() == service.RUNNING
        assert service.stop(config) == 0
        assert capsys.readouterr().out.strip() == "stopped"
        thread.join(10)
    finally:
        server.server_close()
        speaker.close()
    assert service.stop(config) == 0
    assert capsys.readouterr().out.strip() == "not running"


def test_a_second_start_waits_for_a_voice_that_is_still_loading(monkeypatch, tmp_path):
    import types

    release = threading.Event()

    class SlowKokoro:
        def __init__(self, *_):
            release.wait(30)

        def get_voices(self):
            return ["af_heart"]

    monkeypatch.setitem(sys.modules, "kokoro_onnx", types.SimpleNamespace(Kokoro=SlowKokoro))
    monkeypatch.setattr(service.settings, "LOG_FILE", tmp_path / "speaker.log")
    signals: list[str] = []
    monkeypatch.setattr(service, "_signal", signals.append)
    config = Config(port=_free_port())
    results: dict[str, int] = {}

    first = threading.Thread(target=lambda: results.update(first=service.serve(config)), daemon=True)
    first.start()
    deadline = time.monotonic() + 10
    while service._health(config.port) is None and time.monotonic() < deadline:
        time.sleep(0.05)
    assert service._health(config.port) is not None
    assert not service.is_running(config.port)

    second = threading.Thread(target=lambda: results.update(second=service.serve(config)), daemon=True)
    second.start()
    second.join(0.5)
    assert second.is_alive()

    release.set()
    second.join(10)
    assert results["second"] == 0
    assert sorted(signals) == [service.READY, service.RUNNING]
    assert service.is_running(config.port)
    assert service.stop(config) == 0
    first.join(10)
    assert results["first"] == 0
