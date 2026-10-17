import asyncio

import httpx
import openai

from conftest import brain_with
from gnosis.core import Core
from gnosis.journal import Journal


def make(settings, identity, *script):
    events = []
    core = Core(settings, identity, brain=brain_with(settings, *script), emit=events.append)
    return core, events


async def test_answer_streams_then_finishes(settings, identity):
    core, events = make(settings, identity, ["OK"], ["Hello", " there.", " Bye."])
    await core.start()
    ask = await core.ask("  hi  ")
    await core.wait()
    kinds = [e["type"] for e in events]
    assert kinds == ["ready", "started", "text", "text", "text", "done"]
    assert all(e["ask"] == ask for e in events[1:])
    done = events[-1]
    assert done["text"] == "Hello there. Bye."
    assert set(done["timings"]) == {"first_text_ms", "first_sentence_ms", "total_ms"}
    assert [m["content"] for m in core.conversation.messages] == ["hi", "Hello there. Bye."]
    logged = [r["kind"] for r in core.journal.tail()]
    assert logged == ["model_check", "question", "answer"]
    assert (settings.data_dir / "logs").exists()


async def test_a_new_question_stops_the_old_answer(settings, identity):
    slow = {"pieces": ["one ", "two ", "three ", "four "], "delay": 0.05}
    core, events = make(settings, identity, slow, ["Second."])
    first = await core.ask("first")
    await asyncio.sleep(0.12)
    second = await core.ask("second")
    await core.wait()
    await asyncio.sleep(0.2)  # any late text from the first answer would arrive by now
    stopped = next(e for e in events if e["type"] == "interrupted")
    assert stopped["ask"] == first and stopped["text"]
    after = events[events.index(stopped):]
    assert not [e for e in after if e.get("ask") == first and e["type"] == "text"]
    assert events[-1] == {**events[-1], "type": "done", "ask": second, "text": "Second."}
    saved = core.conversation.messages
    assert [m["content"] for m in saved][0] == "first"
    assert saved[1]["interrupted"] is True and saved[1]["content"] == stopped["text"]
    assert [m["content"] for m in saved][2:] == ["second", "Second."]


async def test_stop_button(settings, identity):
    core, events = make(settings, identity, {"pieces": ["a", "b", "c"], "delay": 0.05})
    assert await core.interrupt() is None
    ask = await core.ask("q")
    await asyncio.sleep(0.07)
    assert await core.interrupt() == ask
    assert events[-1]["type"] == "interrupted" and not core.status()["busy"]


async def test_errors_are_reported_not_raised(settings, identity):
    req = httpx.Request("POST", "https://x.invalid")
    core, events = make(settings, identity, openai.APIConnectionError(request=req), ["<think>hmm</think>"],
                        ["Fine."])
    await core.ask("a")
    await core.wait()
    assert events[-1]["type"] == "error" and "couldn't reach" in events[-1]["message"]
    await core.ask("b")
    await core.wait()
    assert events[-1]["type"] == "error" and "empty answer" in events[-1]["message"]
    await core.ask("c")
    await core.wait()
    assert events[-1]["type"] == "done"  # still works after errors


async def test_broken_window_does_not_break_answers(settings, identity):
    def emit(ev):
        raise RuntimeError("window gone")
    core = Core(settings, identity, brain=brain_with(settings, ["Hi."]), emit=emit, journal=Journal(None))
    await core.ask("x")
    await core.wait()
    assert core.conversation.messages[-1]["content"] == "Hi."
    assert any(r["kind"] == "dropped" for r in core.journal.tail())


async def test_question_carries_time_and_history(settings, identity):
    core, _ = make(settings, identity, ["A1."], ["A2."])
    await core.ask("q1")
    await core.wait()
    await core.ask("q2")
    await core.wait()
    sent = core.brain.client.requests[1]["messages"]
    assert sent[0]["role"] == "system" and "Gnosis" in sent[0]["content"]
    assert [m["content"] for m in sent[1:3]] == ["q1", "A1."]
    assert sent[-1]["content"].startswith("[Now: ") and sent[-1]["content"].endswith("q2")
