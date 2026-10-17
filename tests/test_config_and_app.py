import json
import time

import pytest

from conftest import brain_with
from gnosis.app import single
from gnosis.app.runner import CoreRunner
from gnosis.app.window import Api
from gnosis.core import Core
from gnosis.identity import load_identity
from gnosis.settings import load_settings


def test_repo_identity_is_gnosis():
    ident = load_identity()
    assert ident.name == "Gnosis" and ident.wake_words == ("hey gnosis",)


def test_identity_needs_a_name(tmp_path):
    p = tmp_path / "identity.json"
    p.write_text(json.dumps({"name": " "}))
    with pytest.raises(ValueError):
        load_identity(p)


def test_settings_file_overrides_and_rejects_typos(tmp_path):
    p = tmp_path / "settings.toml"
    p.write_text('[brain]\nmodel = "x/y"\nthinking = true\n[app]\ndata_dir = "D:/g"\n')
    s = load_settings(p)
    assert s.brain.model == "x/y" and s.brain.thinking and s.brain.max_tokens == 1024
    assert str(s.data_dir).replace("\\", "/") == "D:/g"
    p.write_text('[brain]\nmodle = "x"\n')
    with pytest.raises(ValueError, match="modle"):
        load_settings(p)
    assert load_settings(tmp_path / "missing.toml").brain.model.startswith("nvidia/")


def test_example_settings_match_the_defaults():
    from gnosis.identity import REPO_ROOT
    assert load_settings(REPO_ROOT / "config" / "settings.example.toml") == load_settings(REPO_ROOT / "nope")


class DummyShell:
    hidden = False

    def hide(self):
        self.hidden = True


def test_window_api_drives_the_core_from_another_thread(settings, identity):
    got = []
    runner = CoreRunner(lambda emit: Core(settings, identity, brain=brain_with(settings, ["OK"], ["Hi there."]),
                                          emit=emit))
    runner.listeners.append(got.append)
    runner.start()
    try:
        api = Api(runner, DummyShell())
        assert api.ask("   ") == {"error": "Type a question first."}
        ask = api.ask("hello")["ask"]
        deadline = time.time() + 5
        while not any(e["type"] == "done" for e in got) and time.time() < deadline:
            time.sleep(0.02)
        assert [e["type"] for e in got if e.get("ask") == ask][-1] == "done"
        assert [m["content"] for m in api.history()] == ["hello", "Hi there."]
        assert api.status()["check"]["ok"] is True
        assert any(r["kind"] == "answer" for r in api.diagnostics())
        api.new_chat()
        assert api.history() == []
    finally:
        runner.stop()


def test_second_start_shows_the_first(monkeypatch):
    monkeypatch.setattr(single, "PORT", 47899)
    shown = []
    assert single.claim(lambda: shown.append(1)) is True
    assert single.claim(lambda: None) is False
    deadline = time.time() + 3
    while not shown and time.time() < deadline:
        time.sleep(0.02)
    assert shown == [1]


def test_icon_draws():
    pytest.importorskip("PIL")
    from gnosis.app.icon import icon_image
    assert icon_image(32).size == (32, 32)
