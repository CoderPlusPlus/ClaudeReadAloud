import re

from markdown_it import MarkdownIt
from markdown_it.token import Token

CODE_NOTE = "Code shown on screen."
TABLE_NOTE = "Table shown on screen."

_parser = MarkdownIt("commonmark").enable(["table", "strikethrough"])

_URL = re.compile(r"\b(?:https?://|www\.)\S*[^\s.,;:!?)\]\"']", re.IGNORECASE)
_EXTENSION = re.compile(r"\.\w{1,5}(?::\d+)?$")
_PLAIN_PART = re.compile(r"[0-9]+|.")
_SYMBOLS = {"→": " to ", "←": " from ", "⇒": " to ", "·": ", ", "…": "...", "&": " and "}
_ENDINGS = ".!?:;"
_LEADING = "(\"'`["
_TRAILING = ".,;:)!?\"'`]"


def _is_path(word: str) -> bool:
    if "\\" in word or word.startswith(("/", "~/", "./", "../")):
        return True
    has_extension = _EXTENSION.search(word) is not None
    if word.count("/") >= 2:
        return has_extension or not all(_PLAIN_PART.fullmatch(part) for part in word.split("/"))
    return "/" in word and has_extension


def _shorten(word: str) -> str:
    core = word.lstrip(_LEADING)
    lead = word[: len(word) - len(core)]
    trimmed = core.rstrip(_TRAILING)
    trail = core[len(trimmed) :]
    if not _is_path(trimmed):
        return word
    name = re.split(r"[\\/]", trimmed.rstrip("\\/"))[-1]
    return lead + name + trail


def _symbols(text: str) -> str:
    for symbol, words in _SYMBOLS.items():
        text = text.replace(symbol, words)
    return text


def _speakable(text: str) -> str:
    text = _URL.sub("a link", text)
    return " ".join(_shorten(word) for word in text.split())


def _inline(children: list[Token]) -> str:
    parts = []
    for child in children:
        if child.type in ("text", "image"):
            parts.append(_symbols(_URL.sub("a link", child.content)))
        elif child.type == "code_inline":
            parts.append(child.content)
        elif child.type in ("softbreak", "hardbreak"):
            parts.append(" ")
    return _speakable("".join(parts))


def _sentence(text: str) -> str:
    if text and text[-1] not in _ENDINGS:
        return text + "."
    return text


def to_speech(markdown: str) -> str:
    """Turns a markdown reply into plain sentences, replacing code and tables with a short note."""
    lines: list[str] = []
    skip_until = None

    def note(text: str) -> None:
        if not lines or lines[-1] != text:
            lines.append(text)

    for token in _parser.parse(markdown):
        if skip_until:
            if token.type == skip_until:
                skip_until = None
            continue
        if token.type in ("fence", "code_block"):
            note(CODE_NOTE)
        elif token.type == "table_open":
            note(TABLE_NOTE)
            skip_until = "table_close"
        elif token.type == "inline":
            spoken = _inline(token.children or [])
            if spoken:
                lines.append(_sentence(spoken))
    return "\n".join(lines)
