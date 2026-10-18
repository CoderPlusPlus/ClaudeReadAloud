import json
import logging
import re
import threading
from datetime import date, datetime, timedelta
from pathlib import Path

KEPT_DAYS = 7
_DAY_FILE = re.compile(r"([0-9]{4}-[0-9]{2}-[0-9]{2})\.jsonl")

log = logging.getLogger(__name__)


def now() -> datetime:
    return datetime.now().astimezone()


def stamp(moment: datetime) -> str:
    return moment.isoformat(timespec="milliseconds")


class SpokenLog:
    """Adds one line per ended job to a file for that day, then removes day files more than a week old. Failures are logged, never raised."""

    def __init__(self, folder: Path):
        self._folder = folder
        self._lock = threading.Lock()
        self._cleaned_on: date | None = None

    def write(self, line: dict, ended: datetime) -> None:
        with self._lock:
            is_written = False
            try:
                self._folder.mkdir(parents=True, exist_ok=True)
                text = json.dumps(line, ensure_ascii=False) + "\n"
                with (self._folder / f"{ended.date().isoformat()}.jsonl").open("a", encoding="utf-8", errors="backslashreplace", newline="\n") as file:
                    file.write(text)
                is_written = True
            except Exception:
                log.exception("could not add job %s to the spoken log", line.get("job"))
            if is_written and self._cleaned_on != ended.date():
                self._remove_old(ended.date())

    def _remove_old(self, today: date) -> None:
        oldest_kept = today - timedelta(days=KEPT_DAYS)
        try:
            paths = list(self._folder.iterdir())
        except OSError:
            log.exception("could not look for old spoken log files")
            return
        self._cleaned_on = today
        for path in paths:
            match = _DAY_FILE.fullmatch(path.name)
            if match is None:
                continue
            try:
                day = date.fromisoformat(match[1])
            except ValueError:
                continue
            if day < oldest_kept:
                try:
                    path.unlink()
                except OSError:
                    log.exception("could not remove old spoken log file %s", path.name)
