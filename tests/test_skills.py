import asyncio
import json

from conftest import FakeLLM, reply, tool_call
from gnosis.app import build
from gnosis.core import skills


def test_requests_get_core_plus_the_skills_they_mention():
    assert skills.skills_for(["What time is it?"]) == {"core"}
    assert "desktop" in skills.skills_for(["type hello in notepad"])
    assert "schedule" in skills.skills_for(["remind me every morning at 7"])
    assert "phone" in skills.skills_for(["call mom on WhatsApp"])
    assert "code" in skills.skills_for(["build me a website and deploy it"])
    assert "vision" in skills.skills_for(["What's in this?\n\n[Attached image \"a.png\", id 1. Use look_at_image]"])


def test_unlisted_tools_are_never_invisible():
    got = skills.tools_of({"core"}, ["get_time", "brand_new_tool", "type_text"])
    assert got == ["get_time", "brand_new_tool"]


def test_more_tools_offers_only_what_isnt_loaded():
    schema = skills.more_tools_schema({"core", "desktop"})
    offered = schema["function"]["parameters"]["properties"]["skill"]["enum"]
    assert "desktop" not in offered and "core" not in offered and "phone" in offered
    assert skills.more_tools_schema({s.name for s in skills.SKILLS}) is None


def test_a_plain_request_sends_far_fewer_tools_and_the_model_can_load_more(settings):
    llm = FakeLLM([reply(calls=[tool_call("more_tools", {"skill": "tasks"})]),
                   reply(calls=[tool_call("list_tasks", {}, "c2")]), reply("Nothing running.")])
    calls = []
    orig = llm.chat

    async def spy(role, messages, tools=None, tags=(), **kw):
        calls.append({t["function"]["name"] for t in tools or []})
        return await orig(role, messages, tools=tools, tags=tags, **kw)

    llm.chat = spy
    g = build(settings, llm=llm)
    total = len(g.tools.names())
    answer = asyncio.run(g.orchestrator.handle("anything going on?"))
    assert answer == "Nothing running."
    assert "get_time" in calls[0] and "list_tasks" not in calls[0] and "more_tools" in calls[0]
    assert len(calls[0]) < total
    assert "list_tasks" in calls[1]  # Loaded for the rest of the task
    assert json.loads(llm.calls[1]["messages"][-1]["content"])["loaded"] == "tasks"
