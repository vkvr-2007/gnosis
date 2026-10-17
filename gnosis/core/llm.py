"""One client for every model call: routing, redaction, fallback and logging."""

from __future__ import annotations

import ast
import json
import re
import secrets
import time
from dataclasses import dataclass
from types import SimpleNamespace
from typing import Any, Awaitable, Callable, Iterable

import httpx
import openai
from openai import AsyncOpenAI

from gnosis.core.model_router import ModelRouter, Route
from gnosis.core.redact import redact

CallListener = Callable[[dict[str, Any]], Awaitable[None]]
TextListener = Callable[[str], Awaitable[None]]  # Receives a reply's text as it streams in

_OFFLINE_RETRY_S = 60.0
_EMBED_RETRY_S = 600.0  # Most setups never run an embedding server; don't keep knocking
_THINK = re.compile(r"<think>.*?(</think>|$)", re.S)


class ModelError(RuntimeError):
    """A model call failed in a way worth telling the owner about in plain words."""


def strip_thinking(text: str | None) -> str | None:
    """Removes the <think>...</think> reasoning some Nemotron models write before their answer.

    An unclosed <think> (the reply was cut off mid-thought) is removed to the end. When the chat template
    opens the <think> itself, the reply has only the closing tag, so everything before it is removed.
    """
    if not text:
        return text
    if "<think>" not in text:
        return text.split("</think>", 1)[1].strip() if "</think>" in text else text
    return _THINK.sub("", text).strip()


class _ThinkingFilter:
    """Holds back a streamed <think>...</think> block so only the answer is shown and spoken."""

    def __init__(self) -> None:
        self.buffer = ""
        self.state = "start"  # start: deciding; think: inside reasoning; pass: answer text

    def feed(self, text: str) -> str:
        if self.state == "pass":
            return text
        if self.state == "after":  # Just past </think>: drop the blank space before the answer
            text = text.lstrip()
            if text:
                self.state = "pass"
            return text
        self.buffer += text
        if self.state == "start":
            stripped = self.buffer.lstrip()
            if len(stripped) < len("<think>") and "<think>".startswith(stripped):
                return ""  # Might still become <think>
            if not stripped.startswith("<think>"):
                self.state, out, self.buffer = "pass", self.buffer, ""
                return out
            self.state = "think"
        if "</think>" in self.buffer:
            out = self.buffer.split("</think>", 1)[1].lstrip()
            self.state, self.buffer = ("pass" if out else "after"), ""
            return out
        return ""

    def flush(self) -> str:
        out = self.buffer if self.state == "start" else ""
        self.buffer = ""
        return out


def _for_route(tools: list[dict[str, Any]] | None, route: Route) -> list[dict[str, Any]] | None:
    """The tools this route's model may see (its `tools` list in models.yaml), or all of them."""
    if not tools or route.tools is None:
        return tools
    return [t for t in tools if t.get("function", t)["name"] in route.tools]


def _with_prefix(messages: list[dict[str, Any]], prefix: str | None) -> list[dict[str, Any]]:
    if not prefix:
        return messages
    if messages and messages[0].get("role") == "system":
        return [{**messages[0], "content": f"{prefix}\n\n{messages[0]['content']}"}, *messages[1:]]
    return [{"role": "system", "content": prefix}, *messages]


def _is_parse_error(e: Exception) -> bool:
    text = str(getattr(e, "message", e)).lower()
    return any(w in text for w in ("pars", "format", "grammar"))


def parse_text_tool_call(text: str | None, names: set[str]) -> tuple[str, dict[str, Any]] | None:
    """Finds a tool call a small model wrote as plain JSON, e.g. {"name": "get_time", "parameters": {}}."""
    if not text:
        return None
    decoder = json.JSONDecoder()
    for m in re.finditer(r"\{", text):
        try:
            obj, _ = decoder.raw_decode(text, m.start())
        except ValueError:
            continue
        if isinstance(obj, dict) and obj.get("name") in names:
            args = obj.get("parameters", obj.get("arguments", {}))
            if isinstance(args, str):
                try:
                    args = json.loads(args)
                except ValueError:
                    args = {}
            return obj["name"], args if isinstance(args, dict) else {}
    return _parse_call_style(text, names)


def _parse_call_style(text: str, names: set[str]) -> tuple[str, dict[str, Any]] | None:
    """A reply that is only a Python-style call, e.g. get_time() or open_app(name="Notepad").
    Only keyword arguments with literal values are read; nothing is ever run."""
    m = re.fullmatch(r"\s*`*\s*(?:python\s+)?([A-Za-z_]\w*)\((.*)\)\s*`*\s*", text, re.S)
    if not m or m.group(1) not in names:
        return None
    try:
        call = ast.parse(f"f({m.group(2)})", mode="eval").body
        args = {kw.arg: ast.literal_eval(kw.value) for kw in call.keywords if kw.arg}
    except (SyntaxError, ValueError):
        return None
    return m.group(1), args


def _as_tool_message(name: str, args: dict[str, Any]) -> Any:
    call = SimpleNamespace(id="call_" + secrets.token_hex(4), type="function",
                           function=SimpleNamespace(name=name, arguments=json.dumps(args)))
    return SimpleNamespace(content="", tool_calls=[call])


def _tools_as_text(messages: list[dict[str, Any]], tools: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """The conversation for a model that couldn't use the tools API: the tools are described in words,
    and earlier tool calls and results become plain text."""
    lines = []
    for t in tools:
        f = t.get("function", t)
        props = f.get("parameters", {}).get("properties", {})
        lines.append(f"- {f['name']}({', '.join(props)}): {f.get('description', '')}")
    note = ("To use a tool, reply with only one JSON object and nothing else, like "
            '{"name": "get_time", "parameters": {}}. Otherwise reply normally.\nTools:\n' + "\n".join(lines))
    out: list[dict[str, Any]] = []
    for m in messages:
        if m.get("role") == "assistant" and m.get("tool_calls"):
            calls = "; ".join(f"{c['function']['name']}({c['function']['arguments']})" for c in m["tool_calls"])
            out.append({"role": "assistant", "content": f"(called {calls})"})
        elif m.get("role") == "tool":
            out.append({"role": "user", "content": f"Tool result: {m.get('content', '')}"})
        else:
            out.append(m)
    if out and out[0].get("role") == "system":
        out[0] = {**out[0], "content": f"{out[0]['content']}\n\n{note}"}
    else:
        out.insert(0, {"role": "system", "content": note})
    return out


def _describe(e: Exception, route: Route) -> str:
    where = f"the local model at {route.base_url}" if route.is_local else f"{route.provider} ({route.model})"
    if isinstance(e, openai.APITimeoutError):
        return f"{where} didn't answer within {route.timeout_s:.0f} s"
    if isinstance(e, openai.APIConnectionError):
        return f"couldn't connect to {where}; is it running?"
    if isinstance(e, openai.AuthenticationError):
        return f"{where} rejected the API key"
    if isinstance(e, openai.InternalServerError) and "pars" in str(getattr(e, "message", e)).lower():
        return f"{where} wrote a tool call that couldn't be read (small models do this; try again or rephrase)"
    if isinstance(e, openai.APIStatusError):
        detail = str(getattr(e, "message", e))[:300]
        return f"{where} returned an error ({e.status_code}): {detail}"
    return f"{where} failed: {type(e).__name__}: {e}"


@dataclass
class LLMResult:
    message: Any  # openai ChatCompletionMessage
    route: Route
    redactions: int
    latency_ms: int


def _redact_messages(messages: list[dict[str, Any]]) -> tuple[list[dict[str, Any]], int]:
    total = 0
    out = []
    for m in messages:
        content = m.get("content")
        if isinstance(content, str) and m.get("role") != "system":
            content, n = redact(content)
            total += n
            m = {**m, "content": content}
        out.append(m)
    return out, total


class LLMClient:
    def __init__(self, router: ModelRouter, listener: CallListener | None = None):
        self.router = router
        self.listener = listener
        self._clients: dict[str, AsyncOpenAI] = {}
        self._offline_until = 0.0
        self._embed_down_until = 0.0

    @property
    def online(self) -> bool:
        return time.monotonic() >= self._offline_until

    def _client(self, route: Route) -> AsyncOpenAI:
        if route.provider not in self._clients:
            self._clients[route.provider] = AsyncOpenAI(
                base_url=route.base_url,
                api_key=route.api_key or "not-needed",
                # A local server that isn't running should fail at once, not after Windows' ~2 s retry.
                timeout=httpx.Timeout(route.timeout_s, connect=0.5 if route.is_local else 10.0),
                # A retry against a busy local server overlaps the request it's still working on.
                max_retries=0 if route.is_local else 1,
            )
        return self._clients[route.provider]

    async def _call(self, route: Route, messages, tools, _tool_names: set[str] | None = None,
                    **kwargs) -> LLMResult:
        redactions = 0
        if not route.is_local:
            messages, redactions = _redact_messages(messages)
        messages = _with_prefix(messages, route.system_prefix)
        tools = _for_route(tools, route)
        started = time.monotonic()
        params: dict[str, Any] = {"model": route.model, "messages": messages, **kwargs}
        if route.temperature is not None:
            params.setdefault("temperature", route.temperature)
        if route.extra_body:
            params["extra_body"] = {**route.extra_body, **params.get("extra_body", {})}
        if tools:
            params["tools"] = tools
        on_text = params.pop("on_text", None)
        if on_text and not route.is_local:
            # Local models sometimes write tool calls as text, which must never be shown or spoken.
            message, usage = await self._stream(route, params, on_text)
        else:
            resp = await self._client(route).chat.completions.create(**params)
            message, usage = resp.choices[0].message, resp.usage
        latency = int((time.monotonic() - started) * 1000)
        message.content = strip_thinking(message.content)
        names = _tool_names or ({t.get("function", t)["name"] for t in tools} if tools else set())
        if names and route.is_local and not message.tool_calls:
            # Small local models sometimes write the tool call as text instead of using the API.
            found = parse_text_tool_call(message.content, names)
            if found:
                message = _as_tool_message(*found)
        result = LLMResult(message, route, redactions, latency)
        if self.listener:
            await self.listener({
                "role": route.role,
                "model": route.model,
                "where": "local" if route.is_local else "cloud",
                "reason": route.reason,
                "redactions": redactions,
                "latency_ms": latency,
                "tokens": getattr(usage, "total_tokens", None) if usage else None,
            })
        return result

    async def _stream(self, route: Route, params: dict[str, Any], on_text: TextListener) -> tuple[Any, Any]:
        """Streams a reply, passing its visible text to `on_text` as it arrives. Returns the whole
        message (text and tool calls, put back together) and the token usage."""
        stream = await self._client(route).chat.completions.create(
            **params, stream=True, stream_options={"include_usage": True})
        content: list[str] = []
        calls: dict[int, dict[str, str]] = {}
        hide = _ThinkingFilter()
        usage = None
        async for chunk in stream:
            usage = getattr(chunk, "usage", None) or usage
            if not chunk.choices:
                continue
            delta = chunk.choices[0].delta
            if delta.content:
                content.append(delta.content)
                visible = hide.feed(delta.content)
                if visible:
                    await on_text(visible)
            for tc in delta.tool_calls or []:
                slot = calls.setdefault(tc.index, {"id": "", "name": "", "args": ""})
                slot["id"] = tc.id or slot["id"]
                if tc.function is not None:
                    slot["name"] += tc.function.name or ""
                    slot["args"] += tc.function.arguments or ""
        rest = hide.flush()
        if rest:
            await on_text(rest)
        tool_calls = [SimpleNamespace(id=s["id"] or "call_" + secrets.token_hex(4), type="function",
                                      function=SimpleNamespace(name=s["name"], arguments=s["args"] or "{}"))
                      for _, s in sorted(calls.items())]
        return SimpleNamespace(content="".join(content) or None, tool_calls=tool_calls or None), usage

    async def chat(
        self,
        role: str,
        messages: list[dict[str, Any]],
        tools: list[dict[str, Any]] | None = None,
        tags: Iterable[str] = (),
        **kwargs: Any,
    ) -> LLMResult:
        route = self.router.choose(role, tags, online=self.online)
        tools = _for_route(tools, route)
        try:
            try:
                return await self._call(route, messages, tools, **kwargs)
            except openai.InternalServerError as e:
                if tools and route.is_local and _is_parse_error(e):
                    # The model wrote a tool call llama.cpp couldn't parse. Ask again with the tools
                    # described in words, and read the tool call from its text.
                    return await self._call(route, _tools_as_text(messages, tools), None,
                                            _tool_names={t.get("function", t)["name"] for t in tools}, **kwargs)
                # Often a one-off.
                return await self._call(route, messages, tools, **kwargs)
        except (openai.APIConnectionError, openai.APITimeoutError, openai.InternalServerError) as e:
            fallback = self.router.fallback(route)
            if fallback is None:
                raise ModelError(_describe(e, route)) from e
            if not isinstance(e, openai.InternalServerError):
                self._offline_until = time.monotonic() + _OFFLINE_RETRY_S
            try:
                return await self._call(fallback, messages, tools, **kwargs)
            except openai.APIError as e2:
                raise ModelError(f"{_describe(e, route)}, and then {_describe(e2, fallback)}") from e2
        except openai.APIError as e:
            raise ModelError(_describe(e, route)) from e

    async def embed(self, texts: list[str]) -> list[list[float]] | None:
        """Embeds text with the on-device embedding model, or returns None if there isn't one running.

        Memory is personal, so embeddings never use a cloud model.
        """
        route = self.router.embedding_route()
        if route is None or not texts or time.monotonic() < self._embed_down_until:
            return None
        try:
            resp = await self._client(route).embeddings.create(model=route.model, input=texts)
        except (openai.APIError, openai.APIConnectionError):
            self._embed_down_until = time.monotonic() + _EMBED_RETRY_S
            return None
        return [d.embedding for d in sorted(resp.data, key=lambda d: d.index)]
