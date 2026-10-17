import asyncio
import json

import pytest

from conftest import FakeLLM, reply, tool_call
from gnosis.app import build
from gnosis.teach.recorder import steps_from_trace
from gnosis.teach.skills import Skill, SkillError, SkillStore, validate


def test_trace_becomes_steps_by_element_name():
    trace = [
        {"kind": "click", "app": "EXCEL", "name": "File", "type": "TabItemControl"},
        {"kind": "click", "app": "EXCEL", "name": "Save As", "type": "ListItemControl"},
        {"kind": "text", "text": "Report "}, {"kind": "text", "text": "March"},
        {"kind": "key", "combo": "enter"},
        {"kind": "skipped", "reason": "Typing in a password field wasn't recorded"},
        {"kind": "click", "app": "chrome", "name": "", "type": "PaneControl"},
        {"kind": "key", "combo": "ctrl+s"}, {"kind": "key", "combo": "enter"},
    ]
    steps, notes = steps_from_trace(trace)
    assert steps == [
        {"tool": "focus_window", "args": {"name": "EXCEL"}},
        {"tool": "click_element", "args": {"name": "File", "control_type": "TabItemControl"}},
        {"tool": "click_element", "args": {"name": "Save As", "control_type": "ListItemControl"}},
        {"tool": "type_text", "args": {"text": "Report March"}},
        {"tool": "press_keys", "args": {"keys": "enter"}},
        {"tool": "focus_window", "args": {"name": "chrome"}},
        {"tool": "press_keys", "args": {"keys": "ctrl+s enter"}},
    ]
    assert len(notes) == 2 and "password" in notes[0]


def test_skill_files_round_trip_and_validation(tmp_path):
    store = SkillStore(tmp_path)
    skill = Skill("monthly-report", "Saves the monthly report", [
        {"tool": "focus_window", "args": {"name": "EXCEL"}},
        {"tool": "type_text", "args": {"text": "Report {month}"}}], ["month"], "taught")
    validate(skill, {"focus_window", "type_text"})
    store.save(skill)
    text = (tmp_path / "monthly-report" / "SKILL.md").read_text()
    assert text.startswith("---\nname: monthly-report") and "1. `focus_window` name=\"EXCEL\"" in text
    loaded = store.get("monthly-report")
    assert loaded.steps == skill.steps and loaded.params == ["month"]
    assert loaded.filled({"month": "March"})[1]["args"]["text"] == "Report March"
    with pytest.raises(SkillError, match="needs: month"):
        loaded.filled({})
    for bad, message in [
        (Skill("x", "d", [{"tool": "type_text", "args": {"text": "{who}"}}]), "who"),
        (Skill("x", "d", [{"tool": "run_skill", "args": {}}]), "can't use run_skill"),
        (Skill("x", "d", [{"tool": "nope", "args": {}}]), "no tool"),
        (Skill("Bad Name", "d", [{"tool": "type_text"}]), "lowercase"),
    ]:
        with pytest.raises(SkillError, match=message):
            validate(bad, {"type_text", "run_skill"})
    assert store.delete("monthly-report") and store.all() == []


def run(g, text, approve=True, session="default"):
    async def go():
        q = g.events.subscribe()

        async def answer():
            while True:
                ev = await q.get()
                if ev["type"] == "approval_needed":
                    g.approvals.resolve(ev["approval_id"], approve)
        t = asyncio.create_task(answer())
        try:
            return await g.orchestrator.handle(text, session)
        finally:
            t.cancel()
    return asyncio.run(go())


def test_save_what_you_just_did_then_run_it_again(settings):
    typed = []
    steps = [{"tool": "note", "args": {"text": "Expenses for {month}"}}]
    g = build(settings, llm=FakeLLM([
        reply(calls=[tool_call("note", {"text": "Expenses for February"})]), reply("Noted."),
        reply(calls=[tool_call("recent_actions", {})]),
        reply(calls=[tool_call("save_skill", {"name": "expense-note", "description": "Writes the expense note",
                                              "params": ["month"], "steps": steps})]),
        reply("Saved."),
        reply(calls=[tool_call("run_skill", {"name": "expense-note", "params": {"month": "March"}})]),
        reply("Done for March."),
    ]))
    g.tools.tool("note", "Write a note", {"type": "object", "properties": {"text": {"type": "string"}}})(
        lambda text: typed.append(text) or "ok")
    g.policy.tools["note"] = "allow"

    run(g, "write the expense note for February")
    run(g, "save that as a skill")
    recap = json.loads(g.llm.calls[3]["messages"][-1]["content"])
    assert recap == {"request": "write the expense note for February",
                     "steps": [{"tool": "note", "args": {"text": "Expenses for February"}}]}
    assert [s.name for s in SkillStore(settings.data_dir / "skills").all()] == ["expense-note"]

    run(g, "do the expense note for March")
    assert typed == ["Expenses for February", "Expenses for March"]
    # The saved skill is listed for the model on later requests
    assert any("expense-note: Writes the expense note (needs: month)" in m["content"]
               for m in g.llm.calls[-1]["messages"] if m["role"] == "system")


def test_skills_need_approval_and_their_steps_still_go_through_policy(settings):
    g = build(settings, llm=FakeLLM([
        reply(calls=[tool_call("save_skill", {"name": "buy", "description": "d",
                                              "steps": [{"tool": "send_message", "args": {"text": "hi"}}]})]),
        reply("Not saved."),
    ]))
    g.tools.tool("send_message", "Send", {"type": "object", "properties": {"text": {"type": "string"}}})(
        lambda text: "sent")
    run(g, "save a skill", approve=False)
    assert SkillStore(settings.data_dir / "skills").all() == []

    sent = []
    SkillStore(settings.data_dir / "skills").save(
        Skill("greet", "Says hi", [{"tool": "send_message", "args": {"text": "hi"}}]))
    g = build(settings, llm=FakeLLM([reply(calls=[tool_call("run_skill", {"name": "greet"})]), reply("Stopped.")]))
    g.tools.tool("send_message", "Send", {"type": "object", "properties": {"text": {"type": "string"}}})(
        lambda text: sent.append(text) or "sent")
    run(g, "run greet", approve=False)  # run_skill is allowed, but send_message inside it still asks
    assert sent == []
    assert "Step 1 (send_message) failed" in g.llm.calls[-1]["messages"][-1]["content"]
