import json
import logging
import threading
from datetime import datetime
from pathlib import Path

import pytest

from claudevoice.config import Config
from claudevoice.engine import Speaker
from claudevoice.spoken import SpokenLog
from claudevoice.text import to_speech
from tests.fakes import FakeSynthesizer, make_speaker


@pytest.fixture
def close_later():
    speakers = []
    yield speakers.append
    for speaker in speakers:
        speaker.close()


def lines_in(folder: Path) -> list[dict]:
    return [json.loads(line) for path in sorted(folder.glob("*.jsonl")) for line in path.read_text(encoding="utf-8").splitlines()]


def local_time(text: str) -> datetime:
    moment = datetime.fromisoformat(text)
    assert moment.utcoffset() is not None
    return moment


def test_every_job_writes_one_line_when_it_ends_whatever_the_result(tmp_path, close_later):
    speaker, players, _ = make_speaker(holds=True, spoken_log=SpokenLog(tmp_path))
    close_later(speaker)
    record = {"kind": "reply", "toolUseIds": ["toolu_1"], "nested": {"n": 1}}
    markdown = "**Bold** words and `config.json`."
    stopped = speaker.speak(markdown, voice="bm_george", owner="a", record=record)
    assert players.playing()
    speaker.stop()
    assert speaker.wait(stopped)["result"] == "stopped"
    nothing = speaker.speak("", owner="b")
    assert speaker.wait(nothing)["result"] == "nothing"

    lines = lines_in(tmp_path)
    assert [line["job"] for line in lines] == [stopped, nothing]
    first, second = lines
    assert first["result"] == "stopped"
    assert first["owner"] == "a"
    assert first["voice"] == "bm_george"
    assert first["text"] == to_speech(markdown)
    assert first["record"] == record
    assert "error" not in first
    assert local_time(first["start"]) <= local_time(first["played"]) <= local_time(first["end"])
    assert second == {**second, "result": "nothing", "owner": "b", "voice": "af_heart", "text": "", "played": None, "record": None}
    assert local_time(second["start"]) <= local_time(second["end"])
    assert {path.name for path in tmp_path.iterdir()} == {f"{local_time(second['end']).date().isoformat()}.jsonl"}


def test_finished_and_failed_jobs_are_written_too(tmp_path, close_later):
    speaker, _, _ = make_speaker(spoken_log=SpokenLog(tmp_path))
    close_later(speaker)
    finished = speaker.speak("Hello.", record={"kind": "announcement"})
    assert speaker.wait(finished)["result"] == "finished"

    def no_device(_rate):
        raise OSError("no output device")

    failing = Speaker(FakeSynthesizer(), Config(), no_device, spoken_log=SpokenLog(tmp_path))
    close_later(failing)
    failed = failing.speak("Hello.")
    assert failing.wait(failed)["result"] == "error"

    first, second = lines_in(tmp_path)
    assert (first["job"], first["result"], first["text"], first["record"]) == (finished, "finished", "Hello.", {"kind": "announcement"})
    assert (second["job"], second["result"], second["error"]) == (failed, "error", "no output device")


def test_files_more_than_a_week_old_are_removed_when_a_line_is_written(tmp_path):
    names = [
        "2026-10-09.jsonl",
        "2026-09-01.jsonl",
        "2026-10-10.jsonl",
        "2026-10-16.jsonl",
        "notes.txt",
        "2026-10-01.jsonl.bak",
        "2026-10-01.log",
        "old-2026-10-01.jsonl",
        "2026-13-45.jsonl",
    ]
    for name in names:
        (tmp_path / name).write_text("{}\n", encoding="utf-8")
    ended = datetime(2026, 10, 17, 0, 5).astimezone()
    SpokenLog(tmp_path).write({"job": 1}, ended)
    assert sorted(path.name for path in tmp_path.iterdir()) == sorted(
        set(names) - {"2026-10-09.jsonl", "2026-09-01.jsonl"} | {"2026-10-17.jsonl"}
    )
    assert (tmp_path / "2026-10-17.jsonl").read_text(encoding="utf-8") == '{"job": 1}\n'


def test_a_file_that_cannot_be_removed_is_logged_and_the_others_still_go(tmp_path, monkeypatch, caplog):
    for name in ["2026-01-01.jsonl", "2026-01-02.jsonl"]:
        (tmp_path / name).write_text("{}\n", encoding="utf-8")
    real_unlink = Path.unlink

    def locked(path, *args, **kwargs):
        if path.name == "2026-01-01.jsonl":
            raise PermissionError("in use")
        return real_unlink(path, *args, **kwargs)

    monkeypatch.setattr(Path, "unlink", locked)
    with caplog.at_level(logging.ERROR, logger="claudevoice.spoken"):
        SpokenLog(tmp_path).write({"job": 1}, datetime(2026, 10, 17, 12).astimezone())
    assert sorted(path.name for path in tmp_path.iterdir()) == ["2026-01-01.jsonl", "2026-10-17.jsonl"]
    assert "could not remove old spoken log file 2026-01-01.jsonl" in caplog.text


def test_a_log_that_cannot_be_written_does_not_stop_speech(tmp_path, close_later, caplog):
    blocked = tmp_path / "spoken"
    blocked.write_text("a file where the folder should be", encoding="utf-8")
    speaker, _, synthesizer = make_speaker(spoken_log=SpokenLog(blocked))
    close_later(speaker)
    with caplog.at_level(logging.ERROR, logger="claudevoice"):
        first = speaker.speak("First.")
        assert speaker.wait(first)["result"] == "finished"
        second = speaker.speak("Second.")
        assert speaker.wait(second)["result"] == "finished"
    assert synthesizer.spoken == ["First.", "Second."]
    assert "could not add job 1 to the spoken log" in caplog.text
    assert "could not add job 2 to the spoken log" in caplog.text
    assert "could not look for old spoken log files" not in caplog.text


def test_a_log_that_raises_does_not_stop_speech(close_later, caplog):
    class Broken:
        def write(self, line, ended):
            raise RuntimeError("disk gone")

    speaker, _, synthesizer = make_speaker(spoken_log=Broken())
    close_later(speaker)
    with caplog.at_level(logging.ERROR, logger="claudevoice.engine"):
        job = speaker.speak("Hello.")
        assert speaker.wait(job) == {"job": job, "result": "finished"}
        nothing = speaker.speak("")
        assert speaker.wait(nothing) == {"job": nothing, "result": "nothing"}
    assert synthesizer.spoken == ["Hello."]
    assert f"job {job}: could not add it to the spoken log" in caplog.text


def test_text_with_an_unpaired_surrogate_still_gets_its_line(tmp_path):
    ended = datetime(2026, 10, 17, 12).astimezone()
    log = SpokenLog(tmp_path)
    log.write({"job": 1, "text": "broken \ud83d here"}, ended)
    log.write({"job": 2, "text": "fine"}, ended)
    assert [line["job"] for line in lines_in(tmp_path)] == [1, 2]
    assert lines_in(tmp_path)[0]["text"] == "broken \ud83d here"


def test_old_files_are_looked_for_once_a_day(tmp_path):
    log = SpokenLog(tmp_path)
    log.write({"job": 1}, datetime(2026, 10, 17, 12).astimezone())
    old = tmp_path / "2026-01-01.jsonl"
    old.write_text("{}\n", encoding="utf-8")
    log.write({"job": 2}, datetime(2026, 10, 17, 13).astimezone())
    assert old.exists()
    log.write({"job": 3}, datetime(2026, 10, 18, 0, 5).astimezone())
    assert not old.exists()


def test_a_folder_that_could_not_be_listed_is_looked_at_again_on_the_next_line(tmp_path, monkeypatch):
    log = SpokenLog(tmp_path)
    old = tmp_path / "2026-01-01.jsonl"
    old.write_text("{}\n", encoding="utf-8")
    real_iterdir = Path.iterdir

    def broken(path):
        raise OSError("unavailable")

    monkeypatch.setattr(Path, "iterdir", broken)
    log.write({"job": 1}, datetime(2026, 10, 17, 12).astimezone())
    assert old.exists()
    monkeypatch.setattr(Path, "iterdir", real_iterdir)
    log.write({"job": 2}, datetime(2026, 10, 17, 13).astimezone())
    assert not old.exists()


def test_the_log_is_written_off_the_thread_that_plays_sound(tmp_path, close_later):
    threads = []

    class Watching(SpokenLog):
        def write(self, line, ended):
            threads.append(threading.current_thread().name)
            super().write(line, ended)

    speaker, _, _ = make_speaker(spoken_log=Watching(tmp_path))
    close_later(speaker)
    job = speaker.speak("Hello.")
    assert speaker.wait(job)["result"] == "finished"
    assert threads and threads != ["speaker"]
    assert lines_in(tmp_path)[0]["job"] == job
