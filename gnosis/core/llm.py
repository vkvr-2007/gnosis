"""One client for every model call: routing, redaction, fallback and logging."""

from __future__ import annotations

import time
from dataclasses import dataclass
from typing import Any, Awaitable, Callable, Iterable

import openai
from openai import AsyncOpenAI

from gnosis.core.model_router import ModelRouter, Route
from gnosis.core.redact import redact

CallListener = Callable[[dict[str, Any]], Awaitable[None]]

_OFFLINE_RETRY_S = 60.0


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
                timeout=60.0,
                max_retries=1,
            )
        return self._clients[route.provider]

    async def _call(self, route: Route, messages, tools, **kwargs) -> LLMResult:
        redactions = 0
        if not route.is_local:
            messages, redactions = _redact_messages(messages)
        started = time.monotonic()
        params: dict[str, Any] = {"model": route.model, "messages": messages, **kwargs}
        if tools:
            params["tools"] = tools
        resp = await self._client(route).chat.completions.create(**params)
        latency = int((time.monotonic() - started) * 1000)
        result = LLMResult(resp.choices[0].message, route, redactions, latency)
        if self.listener:
            await self.listener({
                "role": route.role,
                "model": route.model,
                "where": "local" if route.is_local else "cloud",
                "reason": route.reason,
                "redactions": redactions,
                "latency_ms": latency,
                "tokens": getattr(resp.usage, "total_tokens", None) if resp.usage else None,
            })
        return result

    async def chat(
        self,
        role: str,
        messages: list[dict[str, Any]],
        tools: list[dict[str, Any]] | None = None,
        tags: Iterable[str] = (),
        **kwargs: Any,
    ) -> LLMResult:
        route = self.router.choose(role, tags, online=self.online)
        try:
            return await self._call(route, messages, tools, **kwargs)
        except (openai.APIConnectionError, openai.APITimeoutError):
            fallback = self.router.fallback(route)
            if fallback is None:
                raise
            self._offline_until = time.monotonic() + _OFFLINE_RETRY_S
            return await self._call(fallback, messages, tools, **kwargs)

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
            self._embed_down_until = time.monotonic() + _OFFLINE_RETRY_S
            return None
        return [d.embedding for d in sorted(resp.data, key=lambda d: d.index)]
