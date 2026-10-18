"""Step 1: the conversation survives quitting and starting Gnosis again; the Start-menu shortcut."""

import asyncio

from fastapi.testclient import TestClient

from conftest import FakeLLM, reply
from gnosis.app import build
from gnosis.server.api import create_app


def test_the_conversation_is_still_there_after_a_restart(settings):
    first = build(settings, llm=FakeLLM([reply("Nice to meet you, Vaarsh.")]))
    asyncio.run(first.orchestrator.handle("My name is Vaarsh", "dashboard"))

    # Quit and start again: a new Gnosis on the same data folder
    llm = FakeLLM([reply("You're Vaarsh.")])
    again = build(settings, llm=llm)
    assert asyncio.run(again.orchestrator.handle("What's my name?", "dashboard")) == "You're Vaarsh."
    sent = [(m["role"], m["content"]) for m in llm.calls[0]["messages"] if m["role"] != "system"]
    assert sent == [("user", "My name is Vaarsh"), ("assistant", "Nice to meet you, Vaarsh."),
                    ("user", "What's my name?")]

    shown = TestClient(create_app(again)).get("/api/conversation").json()
    assert [(m["role"], m["content"]) for m in shown] == [
        ("user", "My name is Vaarsh"), ("assistant", "Nice to meet you, Vaarsh."),
        ("user", "What's my name?"), ("assistant", "You're Vaarsh.")]


def test_test_runs_and_guests_stay_out_of_the_window(settings):
    g = build(settings, llm=FakeLLM([reply("ok"), reply("hi")]))
    asyncio.run(g.orchestrator.handle("bench question", "bench-1234"))
    asyncio.run(g.orchestrator.handle("who are you?", "voice", owner=False))
    assert g.orchestrator.conversation.transcript() == []
    assert g.orchestrator.conversation.recent("bench-1234", 10)[0]["content"] == "bench question"


def test_start_menu_shortcut_opens_the_app_window_with_voice(tmp_path):
    from gnosis.window.shortcut import shortcut_script

    script = shortcut_script(tmp_path / "Gnosis.lnk", tmp_path / "gnosis.ico", voice=True)
    assert "'-m gnosis app --voice'" in script and "Gnosis.lnk" in script and "gnosis.ico" in script
    assert "--voice" not in shortcut_script(tmp_path / "G.lnk", tmp_path / "g.ico", voice=False)
    assert "''" in shortcut_script(tmp_path / "it's" / "G.lnk", tmp_path / "g.ico", voice=True)  # Quoted
