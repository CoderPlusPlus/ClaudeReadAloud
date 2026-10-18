import http.client
import json
import socket
import threading

import pytest

from claudevoice import server as server_module
from claudevoice.server import MAX_BODY_BYTES, MAX_RECORD_BYTES, SpeakerServer
from claudevoice.spoken import SpokenLog
from tests.fakes import make_speaker


@pytest.fixture
def running():
    speaker, players, _ = make_speaker(holds=True)
    server = SpeakerServer(0, speaker)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    yield server, players
    server.shutdown()
    server.server_close()
    speaker.close()


def call(server, method, path, body=None, headers=None):
    connection = http.client.HTTPConnection("127.0.0.1", server.server_address[1], timeout=10)
    data = None if body is None else (body if isinstance(body, bytes) else json.dumps(body).encode())
    connection.request(method, path, body=data, headers=headers or {})
    response = connection.getresponse()
    result = response.status, json.loads(response.read())
    connection.close()
    return result


def test_health_names_the_service(running):
    server, _ = running
    assert call(server, "GET", "/health") == (200, {"service": "claudevoice", "ready": True, "speaking": False})


def test_speak_wait_and_stop(running):
    server, players = running
    status, body = call(server, "POST", "/speak", {"text": "Hello."})
    assert status == 200
    assert players.playing()
    assert call(server, "GET", "/health")[1]["speaking"] is True
    assert call(server, "POST", "/stop") == (200, {"stopped": True})
    assert call(server, "GET", f"/wait?job={body['job']}") == (200, {"job": body["job"], "result": "stopped"})


def test_web_pages_are_refused(running):
    server, players = running
    status, _ = call(server, "POST", "/speak", {"text": "Hi."}, {"Origin": "https://example.com"})
    assert status == 403
    assert players.made == []
    assert call(server, "GET", "/health", headers={"Origin": "null"})[0] == 403


@pytest.mark.parametrize(
    "body, status",
    [
        (b"not json", 400),
        ([1, 2], 400),
        ({"text": 5}, 400),
        ({}, 400),
    ],
)
def test_bad_speak_requests(running, body, status):
    server, _ = running
    assert call(server, "POST", "/speak", body)[0] == status


def test_text_that_is_too_long_is_refused(running):
    server, _ = running
    for _ in range(5):
        status, body = call(server, "POST", "/speak", {"text": "a" * (MAX_BODY_BYTES + 1)})
        assert (status, body) == (413, {"error": "text is too long"})


def test_a_server_without_a_voice_yet_says_so():
    server = SpeakerServer(0)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        assert call(server, "GET", "/health") == (200, {"service": "claudevoice", "ready": False, "speaking": False})
        assert call(server, "POST", "/speak", {"text": "Hi."})[0] == 503
    finally:
        server.shutdown()
        server.server_close()


def test_odd_digits_are_refused_not_crashed_on(running):
    server, _ = running
    assert call(server, "GET", "/wait?job=%C2%B2")[0] == 400
    assert call(server, "GET", "/wait?job=1_0")[0] == 400
    assert call(server, "GET", "/wait?job=" + "9" * 5000)[1]["result"] == "unknown"
    with socket.create_connection(("127.0.0.1", server.server_address[1]), timeout=10) as raw:
        raw.sendall(b"POST /speak HTTP/1.0\r\nContent-Length: \xb2\r\n\r\n")
        reply = b""
        while chunk := raw.recv(4096):
            reply += chunk
        assert reply.startswith(b"HTTP/1.0 400")


def test_bad_wait_requests(running):
    server, _ = running
    assert call(server, "GET", "/wait")[0] == 400
    assert call(server, "GET", "/wait?job=abc")[0] == 400
    assert call(server, "GET", "/wait?job=42")[1]["result"] == "unknown"


def test_unknown_paths(running):
    server, _ = running
    assert call(server, "GET", "/nope")[0] == 404
    assert call(server, "POST", "/nope")[0] == 404


def test_a_second_copy_cannot_take_the_port(running):
    server, _ = running
    with pytest.raises(OSError):
        SpeakerServer(server.server_address[1])


def test_shutdown_stops_the_server():
    speaker, _, _ = make_speaker()
    server = SpeakerServer(0, speaker)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    assert call(server, "POST", "/shutdown") == (200, {"shutdown": True})
    thread.join(10)
    assert not thread.is_alive()
    server.server_close()
    speaker.close()
    with pytest.raises(OSError):
        socket.create_connection(("127.0.0.1", server.server_address[1]), timeout=2)


def test_speak_takes_a_voice_owner_and_queue_and_stop_takes_an_owner(running):
    server, players = running
    status, body = call(server, "POST", "/speak", {"text": "Hi.", "voice": "bm_george", "owner": "a"})
    assert status == 200
    assert players.playing()
    assert call(server, "POST", "/stop", {"owner": "b"}) == (200, {"stopped": True})
    assert call(server, "GET", "/health")[1]["speaking"] is True
    assert call(server, "POST", "/stop", {"owner": "a"}) == (200, {"stopped": True})
    assert call(server, "GET", f"/wait?job={body['job']}")[1]["result"] == "stopped"


@pytest.mark.parametrize(
    "body",
    [
        {"text": "Hi.", "voice": "jf_alpha"},
        {"text": "Hi.", "voice": 5},
        {"text": "Hi.", "owner": 5},
        {"text": "Hi.", "queue": "yes"},
        {"text": "Hi.", "after_own": "yes"},
        {"text": "Hi.", "after_own": True},
        {"text": "Hi.", "owner": "a", "after_own": True, "queue": True},
    ],
)
def test_bad_speak_options_are_refused(running, body):
    server, players = running
    assert call(server, "POST", "/speak", body)[0] == 400
    assert players.made == []


def test_stop_with_a_bad_owner_is_refused(running):
    server, _ = running
    assert call(server, "POST", "/stop", {"owner": 5})[0] == 400


def test_stop_takes_a_job(running):
    server, players = running
    status, body = call(server, "POST", "/speak", {"text": "Hi.", "owner": "a"})
    assert players.playing()
    assert call(server, "POST", "/stop", {"job": body["job"] + 1}) == (200, {"stopped": True})
    assert call(server, "GET", "/health")[1]["speaking"] is True
    assert call(server, "POST", "/stop", {"job": body["job"]}) == (200, {"stopped": True})
    assert call(server, "GET", f"/wait?job={body['job']}")[1]["result"] == "stopped"


@pytest.mark.parametrize("job", ["1", 1.5, True])
def test_stop_with_a_bad_job_is_refused(running, job):
    server, _ = running
    assert call(server, "POST", "/stop", {"job": job})[0] == 400


def test_pause_and_resume_take_an_owner(running, monkeypatch):
    monkeypatch.setattr(server_module, "WAIT_HOLD_SECONDS", 0.2)
    server, players = running
    job = call(server, "POST", "/speak", {"text": "Hi.", "owner": "a"})[1]["job"]
    assert players.playing()
    assert call(server, "POST", "/pause", {"owner": "a"}) == (200, {"paused": True})
    assert call(server, "GET", "/health")[1]["speaking"] is False
    assert call(server, "GET", f"/wait?job={job}")[1] == {"job": job, "result": "waiting"}
    assert call(server, "POST", "/resume", {"owner": "a"}) == (200, {"paused": False})
    assert players.playing(2)
    players.made[1].close()
    assert call(server, "GET", f"/wait?job={job}")[1]["result"] == "finished"


@pytest.mark.parametrize("path", ["/pause", "/resume"])
@pytest.mark.parametrize("body", [{}, {"owner": ""}, {"owner": 5}])
def test_pause_and_resume_without_an_owner_are_refused(running, path, body):
    server, _ = running
    assert call(server, "POST", path, body)[0] == 400


@pytest.fixture
def logged(tmp_path):
    speaker, players, _ = make_speaker(spoken_log=SpokenLog(tmp_path))
    server = SpeakerServer(0, speaker)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    yield server, players, tmp_path
    server.shutdown()
    server.server_close()
    speaker.close()


def test_a_record_is_kept_as_sent_on_the_job_line(logged):
    server, _, folder = logged
    record = {"session": "s1", "kind": "catch-up", "original": [{"kind": "reply", "toolUseIds": ["toolu_9"]}]}
    status, body = call(server, "POST", "/speak", {"text": "Hi.", "owner": "s1", "record": record})
    assert status == 200
    assert call(server, "GET", f"/wait?job={body['job']}")[1]["result"] == "finished"
    status, body = call(server, "POST", "/speak", {"text": "Bye."})
    assert call(server, "GET", f"/wait?job={body['job']}")[1]["result"] == "finished"
    lines = [json.loads(line) for path in folder.glob("*.jsonl") for line in path.read_text(encoding="utf-8").splitlines()]
    assert [(line["text"], line["owner"], line["record"]) for line in lines] == [("Hi.", "s1", record), ("Bye.", "", None)]


@pytest.mark.parametrize("record", [None, [], "reply", 5, True])
def test_a_record_that_is_not_an_object_is_refused(logged, record):
    server, players, folder = logged
    assert call(server, "POST", "/speak", {"text": "Hi.", "record": record}) == (400, {"error": "record must be a JSON object"})
    assert players.made == []
    assert list(folder.iterdir()) == []


def test_a_large_record_does_not_stop_the_speech(logged):
    server, players, folder = logged
    body = {"text": "Hi.", "record": {"original": "a" * (MAX_BODY_BYTES * 2)}}
    status, reply = call(server, "POST", "/speak", body)
    assert status == 200
    assert call(server, "GET", f"/wait?job={reply['job']}")[1]["result"] == "finished"
    lines = [json.loads(line) for path in folder.glob("*.jsonl") for line in path.read_text(encoding="utf-8").splitlines()]
    assert [line["record"] for line in lines] == [body["record"]]


def test_a_record_too_large_to_keep_is_replaced_and_the_speech_goes_ahead(logged):
    server, players, folder = logged
    body = {"text": "Hi.", "record": {"original": "a" * MAX_RECORD_BYTES}}
    status, reply = call(server, "POST", "/speak", body)
    assert status == 200
    assert call(server, "GET", f"/wait?job={reply['job']}")[1]["result"] == "finished"
    lines = [json.loads(line) for path in folder.glob("*.jsonl") for line in path.read_text(encoding="utf-8").splitlines()]
    assert [line["record"] for line in lines] == [{"omitted": "the record was too large to keep"}]


def test_text_over_the_limit_is_refused_even_with_a_record(logged):
    server, players, folder = logged
    body = {"text": "a" * (MAX_BODY_BYTES + 1), "record": {"session": "s1"}}
    assert call(server, "POST", "/speak", body) == (413, {"error": "text is too long"})
    assert players.made == []
    assert list(folder.iterdir()) == []


def test_speak_takes_a_paused_flag(running):
    server, players = running
    assert call(server, "POST", "/speak", {"text": "Hi.", "owner": "a", "paused": "yes"})[0] == 400
    job = call(server, "POST", "/speak", {"text": "Hi.", "owner": "a", "paused": True})[1]["job"]
    assert call(server, "POST", "/resume", {"owner": "a"}) == (200, {"paused": False})
    assert players.playing()
    players.made[0].close()
    assert call(server, "GET", f"/wait?job={job}")[1]["result"] == "finished"
