import asyncio

import httpx
import openai

import pytest

from gnosis.core.llm import LLMClient, ModelError, _redact_messages, _with_prefix, strip_thinking
from gnosis.core.model_router import ModelRouter


def test_cloud_messages_are_redacted_but_not_system():
    msgs = [{"role": "system", "content": "password: keep"}, {"role": "user", "content": "password: hunter2"}]
    out, n = _redact_messages(msgs)
    assert n == 1 and out[0]["content"] == "password: keep" and "hunter2" not in out[1]["content"]


def test_falls_back_to_local_when_cloud_unreachable(settings):
    client = LLMClient(ModelRouter(settings.models))
    seen = []

    async def fake_call(route, messages, tools, **kw):
        seen.append(route)
        if not route.is_local:
            raise openai.APIConnectionError(request=httpx.Request("POST", "https://x"))
        return "ok"

    client._call = fake_call
    assert asyncio.run(client.chat("planner", [{"role": "user", "content": "hi"}])) == "ok"
    assert [r.is_local for r in seen] == [False, True]
    assert client.online is False
    # While offline, the next call goes straight to the local model.
    seen.clear()
    asyncio.run(client.chat("fast", [{"role": "user", "content": "hi"}]))
    assert [r.is_local for r in seen] == [True]


def _server_error():
    return openai.InternalServerError("bad tool call", response=httpx.Response(
        500, request=httpx.Request("POST", "http://127.0.0.1:8081/v1/chat/completions")), body=None)


def test_server_error_is_retried_once_then_explained(settings):
    client = LLMClient(ModelRouter(settings.models))
    calls = []

    async def flaky(route, messages, tools, **kw):
        calls.append(route.role)
        if len(calls) == 1:
            raise _server_error()
        return "ok"

    client._call = flaky
    assert asyncio.run(client.chat("local", [{"role": "user", "content": "hi"}])) == "ok"

    async def broken(route, messages, tools, **kw):
        raise _server_error()

    client._call = broken
    with pytest.raises(ModelError, match="local model .* returned an error \\(500\\)"):
        asyncio.run(client.chat("local", [{"role": "user", "content": "hi"}]))

    async def unparsable(route, messages, tools, **kw):
        raise openai.InternalServerError("Failed to parse tool call", response=httpx.Response(
            500, request=httpx.Request("POST", "http://127.0.0.1:8081/v1/chat/completions")), body=None)

    client._call = unparsable
    with pytest.raises(ModelError, match="wrote a tool call that couldn't be read"):
        asyncio.run(client.chat("local", [{"role": "user", "content": "hi"}]))


def test_local_routes_wait_longer_than_cloud(settings):
    router = ModelRouter(settings.models)
    assert router.choose("local").timeout_s > router.choose("planner").timeout_s


def test_thinking_is_stripped_and_prefix_added():
    assert strip_thinking("<think>hmm</think>\n\nIt's 11:03.") == "It's 11:03."
    assert strip_thinking("<think>cut off mid-thou") == ""
    assert strip_thinking("plain") == "plain"
    assert strip_thinking("The user wants the time.\n</think>\n\nIt's 11:03.") == "It's 11:03."
    out = _with_prefix([{"role": "system", "content": "You are Gnosis."}], "detailed thinking off")
    assert out[0]["content"].startswith("detailed thinking off\n\nYou are Gnosis.") and len(out) == 1


def test_small_model_tool_calls_written_as_text_still_work(settings):
    from types import SimpleNamespace

    from gnosis.core.llm import parse_text_tool_call

    assert parse_text_tool_call('<x> {"name": "get_time", "parameters": {}}', {"get_time"}) == ("get_time", {})
    assert parse_text_tool_call('{"name": "open_app", "arguments": "{\\"name\\": \\"notepad\\"}"}',
                                {"open_app"}) == ("open_app", {"name": "notepad"})
    assert parse_text_tool_call('{"name": "rm_rf", "parameters": {}}', {"get_time"}) is None
    assert parse_text_tool_call("It's 11:03.", {"get_time"}) is None

    client = LLMClient(ModelRouter(settings.models))
    sent = []

    async def create(**params):
        sent.append(params)
        if "tools" in params:
            raise openai.InternalServerError(
                "The model produced output that does not match the expected peg-native format",
                response=httpx.Response(500, request=httpx.Request("POST", "http://127.0.0.1:8081/v1/")), body=None)
        msg = SimpleNamespace(content='<think>time tool</think>\n{"name": "get_time", "parameters": {}}',
                              tool_calls=None)
        return SimpleNamespace(choices=[SimpleNamespace(message=msg)], usage=None)

    client._client = lambda route: SimpleNamespace(chat=SimpleNamespace(completions=SimpleNamespace(create=create)))
    tools = [{"type": "function", "function": {"name": "get_time", "description": "The time",
                                               "parameters": {"type": "object", "properties": {}}}}]
    history = [{"role": "system", "content": "You are Gnosis."}, {"role": "user", "content": "what time is it?"},
               {"role": "assistant", "content": "", "tool_calls": [
                   {"id": "a", "type": "function", "function": {"name": "get_time", "arguments": "{}"}}]},
               {"role": "tool", "tool_call_id": "a", "content": "10:00"}]
    result = asyncio.run(client.chat("local", history, tools=tools))
    call = result.message.tool_calls[0]
    assert call.function.name == "get_time" and call.function.arguments == "{}"
    retry = sent[-1]["messages"]
    assert "tools" not in sent[-1] and "- get_time(): The time" in retry[0]["content"]
    assert retry[2] == {"role": "assistant", "content": "(called get_time({}))"}
    assert retry[3] == {"role": "user", "content": "Tool result: 10:00"}
