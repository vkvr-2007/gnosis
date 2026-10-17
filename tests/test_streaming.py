import asyncio
from types import SimpleNamespace

from fastapi.testclient import TestClient

from conftest import FakeLLM, reply, tool_call
from gnosis.app import build
from gnosis.core.llm import LLMClient, _ThinkingFilter
from gnosis.core.model_router import ModelRouter
from gnosis.server.api import create_app


def test_thinking_is_held_back_while_streaming():
    f = _ThinkingFilter()
    out = [f.feed(p) for p in ["<thi", "nk>let me see", "...</think>", " It's 9 PM."]] + [f.flush()]
    assert "".join(out) == "It's 9 PM."
    f = _ThinkingFilter()
    assert "".join([f.feed("Hel"), f.feed("lo"), f.flush()]) == "Hello"
    f = _ThinkingFilter()
    assert f.feed("<") == "" and f.flush() == "<"  # A lone "<" isn't swallowed


def chunk(content=None, calls=None, usage=None):
    delta = SimpleNamespace(content=content, tool_calls=calls)
    return SimpleNamespace(choices=[SimpleNamespace(delta=delta)] if content or calls else [], usage=usage)


def call_part(index, id=None, name=None, args=None):
    return SimpleNamespace(index=index, id=id, function=SimpleNamespace(name=name, arguments=args))


def test_a_streamed_reply_is_put_back_together_with_its_tool_calls():
    cfg = {"providers": {"cloud": {"base_url": "http://x"}, "p": {"base_url": "http://y", "on_device": True}},
           "roles": {"planner": {"provider": "cloud", "model": "m"}, "local": {"provider": "p", "model": "l"}}}
    client = LLMClient(ModelRouter(cfg))
    parts = [chunk("Let me "), chunk("check."),
             chunk(calls=[call_part(0, "c1", "open_app", '{"na')]), chunk(calls=[call_part(0, args='me": "x"}')]),
             chunk(usage=SimpleNamespace(total_tokens=42))]

    class Completions:
        async def create(self, **params):
            assert params["stream"] is True

            async def gen():
                for p in parts:
                    yield p
            return gen()

    client._clients["cloud"] = SimpleNamespace(chat=SimpleNamespace(completions=Completions()))
    seen = []

    async def on_text(delta):
        seen.append(delta)

    result = asyncio.run(client.chat("planner", [{"role": "user", "content": "open x"}],
                                     tools=[{"type": "function", "function": {"name": "open_app"}}],
                                     on_text=on_text))
    assert "".join(seen) == "Let me check."
    assert result.message.content == "Let me check."
    tc = result.message.tool_calls[0]
    assert (tc.id, tc.function.name, tc.function.arguments) == ("c1", "open_app", '{"name": "x"}')


class StreamingFakeLLM(FakeLLM):
    """Like FakeLLM, but streams each scripted reply's text in two pieces."""

    async def chat(self, role, messages, tools=None, tags=(), on_text=None, **kw):
        result = await super().chat(role, messages, tools=tools, tags=tags, **kw)
        text = result.message.content or ""
        if on_text and text:
            await on_text(text[: len(text) // 2])
            await on_text(text[len(text) // 2:])
        return result


def test_the_stream_endpoint_sends_text_then_the_answer_and_resets_after_a_preamble(settings):
    llm = StreamingFakeLLM([reply("Let me check.", calls=[tool_call("get_time", {})]), reply("It's 9 PM.")])
    g = build(settings, llm=llm)
    body = TestClient(create_app(g)).post("/api/chat/stream", json={"text": "time?"}).text
    events = [line.split(": ", 1)[1] for line in body.splitlines() if line.startswith("event: ")]
    assert events == ["delta", "delta", "reset", "delta", "delta", "done"]
    assert body.rstrip().endswith('data: "It\'s 9 PM."')


def test_the_voice_gets_the_text_as_it_streams(settings):
    llm = StreamingFakeLLM([reply("It's 9 PM.")])
    g = build(settings, llm=llm)
    heard = []

    async def on_text(delta):
        heard.append(delta)

    answer = asyncio.run(g.orchestrator.handle("time?", "voice", on_text=on_text))
    assert answer == "It's 9 PM." and "".join(heard) == "It's 9 PM."
