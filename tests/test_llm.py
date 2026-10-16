import asyncio

import httpx
import openai

from gnosis.core.llm import LLMClient, _redact_messages
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
