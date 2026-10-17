import asyncio
from types import SimpleNamespace

from fastapi.testclient import TestClient

from conftest import reply, tool_call
from gnosis.app import build
from gnosis.core.model_router import Route
from gnosis.core.workers import TaskInfo, match_task
from gnosis.server.api import create_app


class KeyedLLM:
    """Scripts each request separately (tasks run concurrently, so one shared script would race)."""

    online = True

    def __init__(self, scripts):
        self.scripts = {k: list(v) for k, v in scripts.items()}

    async def embed(self, texts):
        return None

    async def chat(self, role, messages, tools=None, tags=(), **kw):
        if "long-term memory" in messages[0]["content"]:
            msg = reply('{"facts": []}')
        else:
            user = next(m["content"] for m in reversed(messages) if m["role"] == "user")
            msg = self.scripts[user].pop(0)
        return SimpleNamespace(message=msg, route=Route(role, "fake", "m", "", None, False, "default"),
                               redactions=0, latency_ms=1)


def uses(tool):
    return [reply(calls=[tool_call(tool, {})]), reply("done")]


def with_tool(settings, scripts, name, resource=None):
    g = build(settings, llm=KeyedLLM(scripts))
    gate, inside = asyncio.Event(), []

    async def work():
        inside.append(1)
        await gate.wait()
        return "ok"

    g.tools.tool(name, "test tool", resource=resource)(work)
    g.policy.tools[name] = "allow"
    return g, gate, inside


async def until(cond, timeout=2.0):
    for _ in range(int(timeout / 0.01)):
        if cond():
            return
        await asyncio.sleep(0.01)
    raise AssertionError("condition never became true")


def test_tasks_run_side_by_side(settings):
    g, gate, inside = with_tool(settings, {"a": uses("fetch"), "b": uses("fetch")}, "fetch")

    async def go():
        (_, ta), (_, tb) = g.orchestrator.submit("a"), g.orchestrator.submit("b")
        await until(lambda: len(inside) == 2)  # Both are inside the tool at once
        gate.set()
        return await asyncio.gather(ta, tb)

    assert asyncio.run(go()) == ["done", "done"]
    assert {t.status for t in g.orchestrator.list_tasks()} == {"done"}


def test_desktop_is_used_by_one_task_at_a_time(settings):
    g, gate, inside = with_tool(settings, {"a": uses("click"), "b": uses("click")}, "click", resource="desktop")

    async def go():
        a, ta = g.orchestrator.submit("a")
        await until(lambda: len(inside) == 1)
        b, tb = g.orchestrator.submit("b")
        await until(lambda: b.status == "waiting")
        assert "desktop" in b.detail and "'a'" in b.detail and len(inside) == 1
        gate.set()
        await asyncio.gather(ta, tb)
        return a, b

    a, b = asyncio.run(go())
    assert a.status == b.status == "done" and len(inside) == 2
    assert not g.orchestrator.locks.lock("desktop").locked()  # Released when the tasks ended


def test_pause_resume_and_cancel(settings):
    g, gate, inside = with_tool(settings, {"a": uses("fetch"), "b": uses("fetch")}, "fetch")
    gate.set()

    async def go():
        a, ta = g.orchestrator.submit("a")
        g.orchestrator.pause(a.id)
        await until(lambda: a.status == "paused")
        assert inside == []
        g.orchestrator.resume(a.id)
        assert await ta == "done"

        b, tb = g.orchestrator.submit("b")
        g.orchestrator.pause(b.id)
        await until(lambda: b.status == "paused")
        assert g.orchestrator.cancel(b.id)
        assert await tb == "Stopped."
        return b

    assert asyncio.run(go()).status == "stopped"


def test_task_tools_find_tasks_by_their_words(settings):
    tasks = [TaskInfo("t1", "build a landing page for Ember", "s"), TaskInfo("t2", "email Rahul", "s")]
    assert match_task(tasks, "how's the website for ember going").id == "t1"
    assert match_task(tasks, "t2").id == "t2"
    assert match_task(tasks, "something else") is None

    g, gate, _ = with_tool(settings, {"build the ember site": uses("fetch")}, "fetch")

    async def go():
        info, task = g.orchestrator.submit("build the ember site")
        await until(lambda: info.status == "running" and info.detail == "fetch")
        listed = await g.tools.get("list_tasks").run()
        paused = await g.tools.get("pause_task").run(task="ember")
        gate.set()
        g.orchestrator.resume(info.id)
        await task
        return listed, paused

    listed, paused = asyncio.run(go())
    assert listed[0]["request"] == "build the ember site" and listed[0]["doing"] == "fetch"
    assert paused == {"pause": True, "task": "build the ember site"}


def test_tasks_api(settings):
    g, gate, _ = with_tool(settings, {"a": uses("fetch")}, "fetch")
    gate.set()
    client = TestClient(create_app(g))
    started = client.post("/api/tasks", json={"text": "a", "session_id": "dashboard"}).json()
    assert started["text"] == "a" and started["session"] == "dashboard"
    assert any(t["id"] == started["id"] for t in client.get("/api/tasks").json())
    assert client.post(f"/api/tasks/{started['id']}/explode").status_code == 404
