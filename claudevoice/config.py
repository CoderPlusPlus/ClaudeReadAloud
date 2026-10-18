import json
from dataclasses import dataclass
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CONFIG_FILE = ROOT / "config.json"
MODEL_FILE = ROOT / "models" / "kokoro-v1.0.onnx"
VOICES_FILE = ROOT / "models" / "voices-v1.0.bin"
LOG_FILE = ROOT / "logs" / "speaker.log"
SERVICE_NAME = "claudevoice"

# The first letter of a Kokoro voice name says its accent.
_LANGUAGES = {"a": "en-us", "b": "en-gb"}


@dataclass(frozen=True)
class Config:
    voice: str = "af_heart"
    speed: float = 1.0
    port: int = 47811

    @property
    def language(self) -> str:
        return language_of(self.voice)


def language_of(voice: str) -> str:
    language = _LANGUAGES.get(voice[:1])
    if language is None:
        raise ValueError(f"Voice {voice!r} is not an English voice")
    return language


def load(path: Path = CONFIG_FILE) -> Config:
    if not path.exists():
        return Config()
    values = json.loads(path.read_text(encoding="utf-8"))
    unknown = set(values) - set(Config.__dataclass_fields__)
    if unknown:
        raise ValueError(f"Unknown settings in {path.name}: {', '.join(sorted(unknown))}")
    config = Config(**values)
    if not isinstance(config.voice, str):
        raise ValueError("voice must be text, like \"af_heart\"")
    if isinstance(config.speed, bool) or not isinstance(config.speed, (int, float)):
        raise ValueError("speed must be a number")
    if isinstance(config.port, bool) or not isinstance(config.port, int):
        raise ValueError("port must be a whole number")
    if not 0.5 <= config.speed <= 2.0:
        raise ValueError(f"speed must be between 0.5 and 2.0, got {config.speed}")
    if not 1024 <= config.port <= 65535:
        raise ValueError(f"port must be between 1024 and 65535, got {config.port}")
    if config.voice[:1] not in _LANGUAGES:
        raise ValueError(f"Voice {config.voice!r} is not an English voice")
    return config
