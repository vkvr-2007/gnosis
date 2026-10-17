import asyncio
import sys

import pytest

from conftest import FakeLLM, reply, tool_call
from gnosis.app import build
from gnosis.coder.sandbox import LocalSandbox, SandboxError, check_path, check_project
from gnosis.core.tools import ToolRegistry
from gnosis.skills.coder_tools import register_coder_tools

needs_bash = pytest.mark.skipif(sys.platform == "win32", reason="The local workspace sandbox runs bash")


def test_names_and_paths_stay_inside_the_workspace():
    assert check_project("ember-coffee") == "ember-coffee"
    for bad in ("Ember", "../x", "a b", "", "x/y"):
        with pytest.raises(SandboxError):
            check_project(bad)
    assert check_path("src\\App.tsx") == "src/App.tsx"
    for bad in ("/etc/passwd", "../secret", "src/../../x", ""):
        with pytest.raises(SandboxError):
            check_path(bad)


@needs_bash
def test_local_sandbox_runs_writes_reads_and_times_out(tmp_path, monkeypatch):
    monkeypatch.setenv("NEBIUS_API_KEY", "secret-should-not-leak")
    box = LocalSandbox(tmp_path)
    assert box.run(None, "mkdir site").code == 0
    box.write("site", "src/index.html", "<h1>Ember 'Coffee'</h1>\n")
    assert box.read("site", "src/index.html") == "<h1>Ember 'Coffee'</h1>\n"
    assert box.run("site", "cat src/index.html | wc -l").output.strip() == "1"
    assert box.run("site", "echo ${NEBIUS_API_KEY:-none}").output.strip() == "none"  # No keys inside
    failed = box.run("site", "echo boom >&2; exit 3")
    assert failed.code == 3 and "boom" in failed.output
    assert box.run("site", "sleep 5", timeout=1).timed_out
    assert box.exists("site") and not box.exists("other")


@needs_bash
def test_build_a_site_through_the_agent(settings, tmp_path):
    script = [
        reply(calls=[tool_call("code_new_project", {"project": "ember", "template": "static"}, "a")]),
        reply(calls=[tool_call("code_write_file", {"project": "ember", "path": "index.html",
                                                   "content": "<h1>Ember</h1>"}, "b")]),
        reply(calls=[tool_call("code_edit_file", {"project": "ember", "path": "index.html",
                                                  "old": "Ember", "new": "Ember Coffee"}, "c")]),
        reply(calls=[tool_call("code_run", {"project": "ember", "command": "grep -c Coffee index.html"}, "d")]),
        reply(calls=[tool_call("deploy", {"project": "ember"}, "e")]),
        reply("Built it. Add a Vercel token and I'll deploy it."),
    ]
    g = build(settings, llm=FakeLLM(script))
    asked = []

    async def go():
        q = g.events.subscribe()

        async def approve():
            while True:
                ev = await q.get()
                if ev["type"] == "approval_needed":
                    asked.append((ev["tool"], ev["reason"]))
                    g.approvals.resolve(ev["approval_id"], True)
        t = asyncio.create_task(approve())
        try:
            return await g.orchestrator.handle("build a coffee shop site called ember")
        finally:
            t.cancel()

    asyncio.run(go())
    results = [m["content"] for m in g.llm.calls[-1]["messages"] if m["role"] == "tool"]
    assert '"created": "ember"' in results[0]
    assert '"exit_code": 0' in results[3] and '"output": "1\\n"' in results[3]
    assert "VERCEL_TOKEN" in results[4]
    # On this (non-WSL) machine code_run asks; deploy asks once for the project
    assert [a[0] for a in asked] == ["code_run", "deploy"]
    assert "project ember" in asked[1][1]
    assert (settings.data_dir / "workspace" / "ember" / "index.html").read_text() == "<h1>Ember Coffee</h1>"


def test_deploy_reads_the_url_and_announces_it(monkeypatch):
    class FakeBox:
        label = "fake"

        def __init__(self):
            self.envs = []

        def run(self, project, command, timeout=300, stdin=None, env=None):
            from gnosis.coder.sandbox import RunResult
            self.envs.append(env)
            return RunResult(0, "Vercel CLI 39\nProduction: https://ember-abc123.vercel.app [3s]\n")

    notices = []

    class FakeNotifier:
        async def notify(self, notice):
            notices.append(notice.body)

    monkeypatch.setenv("VERCEL_TOKEN", "tok")
    reg = ToolRegistry()
    box = FakeBox()
    register_coder_tools(reg, box, FakeNotifier(), isolated=True)
    out = asyncio.run(reg.get("deploy").run(project="ember"))
    assert out == {"deployed": "ember", "url": "https://ember-abc123.vercel.app"}
    assert box.envs == [{"VERCEL_TOKEN": "tok"}]  # The token goes only to the deploy command
    assert notices == ["ember is live at https://ember-abc123.vercel.app"]
    assert reg.get("code_run").escalate({}) is None  # Isolated sandbox: no extra question
