import json
import logging
import re
import socket
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

from .config import SERVICE_NAME
from .engine import Speaker

MAX_BODY_BYTES = 2_000_000
MAX_RECORD_BYTES = 8_000_000
MAX_DRAIN_BYTES = 64_000_000
LOAD_WAIT_SECONDS = 120
# Kept under the time a client is likely to give up on one request; a paused job can wait far longer, so clients ask again.
WAIT_HOLD_SECONDS = 30
_HUGE = 10**18

log = logging.getLogger(__name__)


def _whole_number(text: str) -> int | None:
    if not re.fullmatch(r"[0-9]+", text):
        return None
    return int(text) if len(text) <= 18 else _HUGE


class SpeakerServer(ThreadingHTTPServer):
    allow_reuse_address = False
    daemon_threads = True

    def __init__(self, port: int, speaker: Speaker | None = None):
        self.speaker: Speaker | None = None
        self.ready = threading.Event()
        if speaker is not None:
            self.set_speaker(speaker)
        super().__init__(("127.0.0.1", port), _Handler)

    def set_speaker(self, speaker: Speaker) -> None:
        self.speaker = speaker
        self.ready.set()

    def server_bind(self) -> None:
        # Stops another program that sets address reuse from taking the port too; the port is what keeps one copy running.
        if hasattr(socket, "SO_EXCLUSIVEADDRUSE"):
            self.socket.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
        super().server_bind()


class _Handler(BaseHTTPRequestHandler):
    server: SpeakerServer

    def log_message(self, format: str, *args) -> None:
        log.debug(format, *args)

    def _send(self, status: int, body: dict) -> None:
        data = json.dumps(body).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _refuse_browsers(self) -> bool:
        # Pages send Origin on POST requests and on fetch-style GETs, so this turns both away. Plain GETs from the address bar or other programs carry none and get through.
        if self.headers.get("Origin") is not None:
            self._send(403, {"error": "requests from web pages are not accepted"})
            return True
        return False

    _unread = 0

    def _drain(self) -> None:
        # Unread request bytes make Windows reset the connection on close, and the client loses the reply.
        remaining = min(self._unread, MAX_DRAIN_BYTES)
        self._unread = 0
        while remaining > 0:
            chunk = self.rfile.read(min(remaining, 65536))
            if not chunk:
                break
            remaining -= len(chunk)

    def _read_json(self, limit: int = MAX_BODY_BYTES) -> dict | None:
        length = _whole_number(self.headers.get("Content-Length") or "0")
        if length is None:
            self._send(400, {"error": "Content-Length must be a number"})
            return None
        self._unread = length
        if length > limit:
            self._send(413, {"error": "text is too long"})
            return None
        self._unread = 0
        try:
            body = json.loads(self.rfile.read(length) or b"{}")
        except ValueError:
            self._send(400, {"error": "body is not JSON"})
            return None
        if not isinstance(body, dict):
            self._send(400, {"error": "body must be a JSON object"})
            return None
        return body

    def do_GET(self) -> None:
        if self._refuse_browsers():
            return
        url = urlparse(self.path)
        speaker = self.server.speaker
        if url.path == "/health":
            self._send(
                200, {"service": SERVICE_NAME, "ready": speaker is not None, "speaking": bool(speaker and speaker.is_speaking())}
            )
        elif url.path == "/ready":
            if self.server.ready.wait(LOAD_WAIT_SECONDS):
                self._send(200, {"ready": True})
            else:
                self._send(503, {"error": "the voice is still loading"})
        elif url.path == "/wait" and speaker is not None:
            values = parse_qs(url.query).get("job", [])
            job = _whole_number(values[0]) if len(values) == 1 else None
            if job is None:
                self._send(400, {"error": "job must be a number"})
                return
            self._send(200, speaker.wait(job, WAIT_HOLD_SECONDS))
        else:
            self._send(404, {"error": "not found"})

    def do_POST(self) -> None:
        try:
            self._handle_post()
        finally:
            self._drain()

    def _handle_post(self) -> None:
        length = _whole_number(self.headers.get("Content-Length") or "0")
        self._unread = length or 0
        if self._refuse_browsers():
            return
        path = urlparse(self.path).path
        speaker = self.server.speaker
        if path == "/speak" and speaker is None:
            self._send(503, {"error": "the voice is still loading"})
        elif path == "/speak":
            body = self._read_json(MAX_BODY_BYTES + MAX_RECORD_BYTES)
            if body is None:
                return
            text = body.get("text")
            voice = body.get("voice")
            owner = body.get("owner", "")
            queue = body.get("queue", False)
            after_own = body.get("after_own", False)
            record = body.get("record")
            paused = body.get("paused")
            if not isinstance(text, str):
                self._send(400, {"error": "text must be a string"})
            elif len(text.encode("utf-8")) > MAX_BODY_BYTES:
                self._send(413, {"error": "text is too long"})
            elif voice is not None and (not isinstance(voice, str) or not speaker.knows_voice(voice)):
                self._send(400, {"error": f"unknown voice {voice!r}"})
            elif not isinstance(owner, str) or not isinstance(queue, bool) or not isinstance(after_own, bool):
                self._send(400, {"error": "owner must be a string, and queue and after_own true or false"})
            elif after_own and (queue or not owner):
                self._send(400, {"error": "after_own needs an owner and cannot be combined with queue"})
            elif paused is not None and not isinstance(paused, bool):
                self._send(400, {"error": "paused must be true or false"})
            elif "record" in body and not isinstance(record, dict):
                self._send(400, {"error": "record must be a JSON object"})
            else:
                if isinstance(record, dict) and len(json.dumps(record).encode("utf-8")) > MAX_RECORD_BYTES:
                    record = {"omitted": "the record was too large to keep"}
                job = speaker.speak(text, voice=voice, owner=owner, queue=queue, after_own=after_own, record=record, paused=paused)
                self._send(200, {"job": job})
        elif path == "/stop" and speaker is not None:
            body = self._read_json()
            if body is None:
                return
            owner = body.get("owner")
            job = body.get("job")
            if owner is not None and not isinstance(owner, str):
                self._send(400, {"error": "owner must be a string"})
                return
            if job is not None and (isinstance(job, bool) or not isinstance(job, int)):
                self._send(400, {"error": "job must be a whole number"})
                return
            speaker.stop(owner, job)
            self._send(200, {"stopped": True})
        elif path in ("/pause", "/resume") and speaker is not None:
            body = self._read_json()
            if body is None:
                return
            owner = body.get("owner")
            if not isinstance(owner, str) or not owner:
                self._send(400, {"error": "owner must be a non-empty string"})
                return
            if path == "/pause":
                speaker.pause(owner)
            else:
                speaker.resume(owner)
            self._send(200, {"paused": speaker.is_paused(owner)})
        elif path == "/shutdown":
            self._send(200, {"shutdown": True})
            threading.Thread(target=self.server.shutdown, daemon=True).start()
        else:
            self._send(404, {"error": "not found"})
