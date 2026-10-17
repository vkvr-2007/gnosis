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
