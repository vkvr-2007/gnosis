import asyncio
import json

from conftest import FakeLLM, reply, tool_call
from gnosis.app import build


def run(g, text, approve=None):
    async def go():
        if approve is not None:
            q = g.events.subscribe()
            async def answer():
                while True:
                    ev = await q.get()
                    if ev["type"] == "approval_needed":
                        g.approvals.resolve(ev["approval_id"], approve)
            task = asyncio.create_task(answer())
            try:
                return await g.orchestrator.handle(text)
            finally:
                task.cancel()
        return await g.orchestrator.handle(text)
    return asyncio.run(go())


def test_uses_tool_then_answers(settings):
    llm = FakeLLM([reply(calls=[tool_call("get_time", {})]), reply("It's Friday.")])
    g = build(settings, llm=llm)
    assert run(g, "what day is it?") == "It's Friday."
    tool_msg = llm.calls[1]["messages"][-1]
    assert tool_msg["role"] == "tool" and tool_msg["tool_call_id"] == "c1"
    kinds = [e["kind"] for e in g.audit.recent()]
    assert {"request", "tool_decision", "tool_result", "answer"} <= set(kinds)


def test_denied_tool_is_reported_to_model(settings):
    g = build(settings, llm=FakeLLM([reply(calls=[tool_call("purchase", {})]), reply("I can't buy things.")]))
    g.tools.tool("purchase", "Buy something")(lambda: "bought")
    assert run(g, "buy a phone") == "I can't buy things."
    tool_msg = g.llm.calls[1]["messages"][-1]
    assert "Denied by policy" in tool_msg["content"]


def test_ask_waits_for_owner(settings):
    sent = []
    for approve, expected in [(True, ["hi"]), (False, [])]:
        sent.clear()
        g = build(settings, llm=FakeLLM([reply(calls=[tool_call("send_message", {"text": "hi"})]), reply("ok")]))
        g.tools.tool("send_message", "Send", {"type": "object", "properties": {"text": {"type": "string"}}})(
            lambda text: sent.append(text) or "sent")
        run(g, "message mom", approve=approve)
        assert sent == expected


def test_private_tool_output_keeps_task_local(settings, tmp_path):
    f = tmp_path / "note.txt"
    f.write_text("secret plans")
    g = build(settings, llm=FakeLLM([reply(calls=[tool_call("read_file", {"path": str(f)})]), reply("done")]))
    run(g, "read my note", approve=True)
    assert "local_files" in g.llm.calls[1]["tags"]


def test_bad_arguments_and_tool_errors_go_back_to_model(settings):
    bad = tool_call("read_file", {})
    bad.function.arguments = "{not json"
    g = build(settings, llm=FakeLLM([reply(calls=[bad, tool_call("nope", {}, "c2")]), reply("sorry")]))
    assert run(g, "x") == "sorry"
    outs = [m for m in g.llm.calls[1]["messages"] if m["role"] == "tool"]
    assert "Invalid arguments" in outs[0]["content"] and "No tool named" in outs[1]["content"]


def test_step_limit(settings):
    settings.max_steps = 2
    g = build(settings, llm=FakeLLM([reply(calls=[tool_call("get_time", {})])] * 2))
    assert "step limit" in run(g, "loop forever")


def test_memory_ids_never_reach_the_answer(settings):
    g = build(settings, llm=FakeLLM([reply("You prefer TypeScript [#1] and dark mode. [#12]")]))
    assert run(g, "what do I like?") == "You prefer TypeScript and dark mode."


def test_memory_search_stays_on_the_cloud_model_and_holds_back_sensitive_facts(settings):
    llm = FakeLLM([reply(calls=[tool_call("search_memory", {"query": "mom phone language"})]), reply("ok"),
                   reply(calls=[tool_call("search_memory", {"query": "mom phone language"})]), reply("ok")])
    g = build(settings, llm=llm)
    g.memory.remember("owner", "prefers_language", "TypeScript")
    g.memory.remember("Mom", "phone_number", "+91 98450 00000", sensitive=True)

    run(g, "what's mom's number and my language?")
    result = json.loads(llm.calls[1]["messages"][-1]["content"])
    assert [f["fact"] for f in result["facts"]] == ["owner prefers language: TypeScript"]
    assert "1 sensitive fact" in result["note"]
    assert not (set(llm.calls[1].get("tags") or ()) & g.memory.private_tags)  # Not forced to the local model

    async def private():
        return await g.orchestrator.handle("what's mom's number?", tags={"private"})
    asyncio.run(private())
    result = json.loads(llm.calls[3]["messages"][-1]["content"])
    assert any("98450" in f["fact"] for f in result["facts"]) and "note" not in result


def test_a_claimed_action_without_a_tool_gets_one_nudge(settings):
    llm = FakeLLM([reply("Got it – I’ve saved that."),  # Curly apostrophe, as the model writes it
                   reply(calls=[tool_call("remember", {"subject": "owner", "predicate": "snack", "value": "dosa"})]),
                   reply("Saved: your favourite snack is dosa.")])
    g = build(settings, llm=llm)
    assert run(g, "remember my favourite snack is dosa") == "Saved: your favourite snack is dosa."
    nudge = llm.calls[1]["messages"][-1]["content"]
    assert "[Gnosis check]" in nudge and "remember my favourite snack is dosa" in nudge  # Keeps the request in view
    assert [f.value for f in g.memory.store.facts(True)] == ["dosa"]


def test_passive_claims_are_caught_too():
    # Seen in `gnosis accept`: the model said this without calling remember.
    from gnosis.core.orchestrator import _CLAIMS_ACTION
    for said in ["Okay. Your favorite snack is now recorded as zebra4ff6.", "Noted!",
                 "Got it, saved.", "Your reminder has been set for 9 PM.", "Spotify is open and ready. What would you like to play?", "Notepad is closed.",
                 # Recalled from an old task's episode, with no approval prompt in this one.
                 "The owner declined the action to open Notepad.", "You declined that earlier.",
                 'Notepad is already open, window titled "*hello - Notepad".',
                 'Opened a new blank tab in Notepad and typed "hello from Gnosis" there.',
                 "Notepad closed.", "Reminder set!", "All done."]:
        assert _CLAIMS_ACTION.search(said), said
    for said in ["Your favourite snack is zebra.", "It's 22:47.", "Budget: 1500 rupees. Bananas: 6.",
                 "The word is GNOSIS, and the circle is blue.", "Done.",
                 "Set a budget first, then buy bananas.", "Closed on Sundays, the shop reopens Monday."]:
        assert not _CLAIMS_ACTION.search(said), said


def test_an_action_request_answered_without_a_tool_is_nudged_whatever_the_wording(settings):
    # Seen in `gnosis accept`: narrated instead of done.
    llm = FakeLLM([reply('Opening a new blank tab in Notepad…\nThen typing "hello" there.'),
                   reply(calls=[tool_call("get_time", {})]), reply("Typed it.")])
    g = build(settings, llm=llm)
    assert run(g, "Open a new blank tab in Notepad and type hello there.") == "Typed it."
    assert "[Gnosis check]" in llm.calls[1]["messages"][-1]["content"]

    from gnosis.core.orchestrator import _ASKS_ACTION
    for asked in ["Close Notepad.", "please open spotify", "Hey Gnosis, play jazz", "Can you set a reminder"]:
        assert _ASKS_ACTION.search(asked), asked
    for asked in ["What time is it?", "Is Notepad open?", "Tell me a joke", "What does open source mean?"]:
        assert not _ASKS_ACTION.search(asked), asked


def test_a_plain_answer_or_a_real_action_is_not_nudged(settings):
    g = build(settings, llm=FakeLLM([reply("You prefer TypeScript.")]))
    assert run(g, "what do I like?") == "You prefer TypeScript."
    llm = FakeLLM([reply(calls=[tool_call("get_time", {})]), reply("I've checked: it's 9 PM.")])
    g = build(settings, llm=llm)
    assert run(g, "time?") == "I've checked: it's 9 PM." and len(llm.calls) == 2
