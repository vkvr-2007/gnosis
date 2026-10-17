import asyncio
import json

import httpx

from gnosis.harness import accept
from gnosis.harness.accept import Step, Suite


def fake_server(answer, tools=(), ask_approval=False, waiting_approval=None):
    """A stand-in for `gnosis serve`: one chat answer, an audit log, and optionally an approval."""
    state = {"audit": [{"id": 1, "kind": "request"}], "approvals": [], "answers": [], "posted": []}
    if waiting_approval:
        state["approvals"].append(waiting_approval)

    def handler(request: httpx.Request):
        path = request.url.path
        if path == "/api/audit":
            return httpx.Response(200, json=state["audit"])
        if path == "/api/approvals" and request.method == "GET":
            return httpx.Response(200, json=state["approvals"])
        if path.startswith("/api/approvals/"):
            state["answers"].append((path.rsplit("/", 1)[1], json.loads(request.content)["approved"]))
            state["approvals"] = [a for a in state["approvals"] if a["id"] != path.rsplit("/", 1)[1]]
            return httpx.Response(200, json={"ok": True})
        if path == "/api/chat":
            state["posted"].append(json.loads(request.content))
            for i, t in enumerate(tools):
                state["audit"].append({"id": 10 + i, "kind": "tool_decision", "tool": t})
            if ask_approval:
                state["approvals"].append({"id": "new1", "tool": "type_text", "reason": "has your text"})
            return httpx.Response(200, json={"answer": answer})
        return httpx.Response(404)

    return state, httpx.MockTransport(handler)


def run_step(step, **server):
    state, transport = fake_server(**server)
    suite = Suite("http://gnosis.test")
    suite.client = httpx.AsyncClient(transport=transport)

    async def go():
        if server.get("ask_approval"):
            # The real server blocks until the approval is answered; give the watcher time to see it.
            orig = suite.client.post

            async def slow_post(url, **kw):
                r = await orig(url, **kw)
                if url.endswith("/api/chat"):
                    await asyncio.sleep(0.8)
                return r
            suite.client.post = slow_post
        return await suite.run_step(step)

    return asyncio.run(go()), state


def test_a_step_passes_on_the_right_tool_and_answer():
    result, state = run_step(Step("time", "What time is it?", ["get_time"], r"\d{1,2}:\d{2}"),
                             answer="It's 7:08 PM.", tools=["get_time"])
    assert result.ok and result.tools == ["get_time"]
    assert state["posted"][0]["session_id"].startswith("accept-")


def test_a_step_fails_on_a_missing_tool_or_leaked_memory_id():
    result, _ = run_step(Step("time", "What time is it?", ["get_time"]), answer="Probably evening [#3]")
    assert not result.ok
    assert "didn't call get_time" in result.problems
    assert any("memory id" in p for p in result.problems)


def test_the_suite_declines_only_approvals_it_caused():
    waiting = {"id": "owners", "tool": "vision_click", "reason": "the owner's own request"}
    result, state = run_step(Step("type", "Type hello", ["type_text"]), answer="The owner declined.",
                             ask_approval=True, waiting_approval=waiting)
    assert state["answers"] == [("new1", False)]  # The owner's waiting approval was left alone
    assert result.approvals_declined == ["type_text: has your text"]


def test_desktop_steps_are_opt_in():
    assert any(s.desktop for s in accept.STEPS) and any(not s.desktop for s in accept.STEPS)


def test_model_check_flags_text_instead_of_a_tool_call_and_leaked_thinking():
    from types import SimpleNamespace
    from conftest import reply, tool_call
    from gnosis.harness.models import CASES, RoleReport, _run_case

    class Scripted:
        def __init__(self, *messages):
            self.messages = list(messages)

        async def chat(self, role, messages, tools=None):
            return SimpleNamespace(message=self.messages.pop(0))

    good = RoleReport("planner", "m")
    asyncio.run(_run_case(Scripted(reply(calls=[tool_call("get_time", {})]), reply("It's 18:01.")),
                          "planner", CASES[0], good))
    assert good.passed == 1 and not good.failures

    wrote_text = RoleReport("local", "m")
    asyncio.run(_run_case(Scripted(reply("remember subject: prefers_language value: TypeScript")),
                          "local", CASES[2], wrote_text))
    assert "expected a remember call, got no tool call" in wrote_text.failures[0]

    leaked = RoleReport("local", "m")
    asyncio.run(_run_case(Scripted(reply(calls=[tool_call("get_time", {})]), reply("<think>hm</think> 18:01")),
                          "local", CASES[0], leaked))
    assert "leaks internal text" in leaked.failures[0]
