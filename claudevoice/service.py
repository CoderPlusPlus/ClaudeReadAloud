import json
import logging
import queue
import subprocess
import sys
import threading
import urllib.error
import urllib.request
from logging.handlers import RotatingFileHandler
from pathlib import Path

from . import config as settings
from .config import Config
from .engine import Speaker
from .server import LOAD_WAIT_SECONDS, SpeakerServer
from .spoken import SpokenLog

READY = "ready"
RUNNING = "running"
START_WAIT_SECONDS = 120

log = logging.getLogger(__name__)


def _request(port: int, path: str, method: str = "GET", timeout: float = 5) -> dict | None:
    request = urllib.request.Request(f"http://127.0.0.1:{port}{path}", method=method, data=b"" if method == "POST" else None)
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return json.loads(response.read())
    except (OSError, ValueError):
        return None


def _health(port: int) -> dict | None:
    health = _request(port, "/health")
    return health if health is not None and health.get("service") == settings.SERVICE_NAME else None


def is_running(port: int) -> bool:
    health = _health(port)
    return health is not None and health.get("ready") is True


def _other_copy_ready(port: int) -> bool:
    answer = _request(port, "/ready", timeout=LOAD_WAIT_SECONDS + 5)
    return answer is not None and answer.get("ready") is True


def _signal(message: str) -> None:
    if sys.stdout is not None:
        print(message, flush=True)
        sys.stdout.close()


def _set_up_logging() -> None:
    settings.LOG_FILE.parent.mkdir(exist_ok=True)
    handler = RotatingFileHandler(settings.LOG_FILE, maxBytes=1_000_000, backupCount=2, encoding="utf-8")
    handler.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(name)s: %(message)s"))
    logging.basicConfig(level=logging.INFO, handlers=[handler])


def serve(config: Config) -> int:
    """Runs the speaker until told to shut down; the first line it prints says whether it started."""
    _set_up_logging()
    try:
        server = SpeakerServer(config.port)
    except OSError:
        if _health(config.port) is None:
            message = f"port {config.port} is in use by another program"
        elif _other_copy_ready(config.port):
            _signal(RUNNING)
            return 0
        else:
            message = f"the speaker already on port {config.port} did not finish starting; see {settings.LOG_FILE}"
        log.error(message)
        _signal(message)
        return 1

    thread = threading.Thread(target=server.serve_forever, name="server", daemon=True)
    thread.start()
    with server:
        try:
            from kokoro_onnx import Kokoro

            kokoro = Kokoro(str(settings.MODEL_FILE), str(settings.VOICES_FILE))
            if config.voice not in kokoro.get_voices():
                raise ValueError(f"voice {config.voice!r} is not in the voices file")
        except Exception as error:
            log.exception("could not load the voice model")
            server.shutdown()
            _signal(f"could not load the voice model: {error}")
            return 1

        speaker = Speaker(kokoro, config, voices=kokoro.get_voices(), spoken_log=SpokenLog(settings.SPOKEN_FOLDER))
        try:
            if thread.is_alive():
                server.set_speaker(speaker)
                log.info("listening on port %d with voice %s", config.port, config.voice)
                _signal(READY)
                thread.join()
        finally:
            speaker.close()
            log.info("shut down")
    return 0


def _detached_flags(breakaway: bool) -> dict:
    if sys.platform != "win32":
        return {"start_new_session": True}
    flags = subprocess.DETACHED_PROCESS | subprocess.CREATE_NEW_PROCESS_GROUP
    if breakaway:
        flags |= subprocess.CREATE_BREAKAWAY_FROM_JOB
    return {"creationflags": flags}


def _launch(argv: list[str], cwd: Path) -> subprocess.Popen:
    options = dict(cwd=cwd, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, close_fds=True)
    try:
        return subprocess.Popen(argv, **options, **_detached_flags(breakaway=True))
    except OSError:
        # Some parent programs forbid leaving their process group; the speaker then lives as long as that parent.
        return subprocess.Popen(argv, **options, **_detached_flags(breakaway=False))


def _first_line(process: subprocess.Popen, seconds: float) -> str | None:
    lines: queue.Queue[str] = queue.Queue()
    threading.Thread(target=lambda: lines.put(process.stdout.readline().decode("utf-8", "replace")), daemon=True).start()
    try:
        return lines.get(timeout=seconds).strip()
    except queue.Empty:
        return None


def background_python() -> str:
    windowless = Path(sys.executable).with_name("pythonw.exe")
    return str(windowless if windowless.exists() else sys.executable)


def start(config: Config, argv: list[str] | None = None, wait_seconds: float = START_WAIT_SECONDS) -> int:
    """Starts the speaker on its own unless one is already running, and returns once it can take requests."""
    if is_running(config.port):
        print(RUNNING)
        return 0
    process = _launch(argv or [background_python(), "-m", "claudevoice", "serve"], settings.ROOT)
    line = _first_line(process, wait_seconds)
    if line in (READY, RUNNING):
        print(line)
        return 0
    if line is None:
        print(f"the speaker did not start within {wait_seconds:g} seconds; see {settings.LOG_FILE}")
    else:
        print(line or f"the speaker stopped while starting; see {settings.LOG_FILE}")
    return 1


def stop(config: Config) -> int:
    if _request(config.port, "/shutdown", method="POST") is None:
        print("not running")
    else:
        print("stopped")
    return 0
