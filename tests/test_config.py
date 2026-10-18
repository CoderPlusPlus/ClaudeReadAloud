import json

import pytest

from claudevoice.config import CONFIG_FILE, Config, load


def _write(tmp_path, values):
    path = tmp_path / "config.json"
    path.write_text(json.dumps(values), encoding="utf-8")
    return path


def test_missing_file_uses_defaults(tmp_path):
    assert load(tmp_path / "none.json") == Config()


def test_project_config_loads():
    assert load(CONFIG_FILE).voice


def test_accent_comes_from_the_voice_name(tmp_path):
    assert load(_write(tmp_path, {"voice": "af_heart"})).language == "en-us"
    assert load(_write(tmp_path, {"voice": "bm_george"})).language == "en-gb"


@pytest.mark.parametrize(
    "values",
    [
        {"voice": "jf_alpha"},
        {"voice": 5},
        {"speed": 3},
        {"speed": "fast"},
        {"speed": True},
        {"port": 80},
        {"port": "47811"},
        {"volume": 2},
    ],
)
def test_bad_settings_are_refused(tmp_path, values):
    with pytest.raises(ValueError):
        load(_write(tmp_path, values))
