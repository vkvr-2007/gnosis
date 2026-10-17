"""The brain: streamed answers from Nemotron through any OpenAI-compatible API (NVIDIA today, Nebius later)."""

from __future__ import annotations

import time
from dataclasses import dataclass
from typing import Any, AsyncIterator

import httpx
import openai

from gnosis.settings import BrainSettings

_OPEN, _CLOSE = "<think>", "</think>"


class BrainError(RuntimeError):
    """A model call failed. The message is a plain sentence that can be shown or spoken as is."""


def _partial_suffix(text: str, tag: str) -> int:
    """How many characters at the end of `text` could be the start of `tag`, split across stream pieces."""
    for n in range(min(len(tag) - 1, len(text)), 0, -1):
        if tag.startswith(text[-n:]):
            return n
    return 0


class ThinkFilter:
    """Removes <think>...</think> reasoning from streamed text, even when a tag is split between pieces."""

    def __init__(self) -> None:
        self.buf = ""
        self.inside = False
        self.started = False  # Leading whitespace before the answer is dropped

    def feed(self, piece: str) -> str:
        self.buf += piece
        out = ""
        while True:
            if self.inside:
                end = self.buf.find(_CLOSE)
                if end < 0:
                    keep = _partial_suffix(self.buf, _CLOSE)
                    self.buf = self.buf[len(self.buf) - keep:]
                    break
                self.buf = self.buf[end + len(_CLOSE):]
                self.inside = False
                continue
            start = self.buf.find(_OPEN)
            stray = self.buf.find(_CLOSE)
            if stray >= 0 and (start < 0 or stray < start):
                # The chat template opened the <think> itself: drop the closing tag
                out += self.buf[:stray]
                self.buf = self.buf[stray + len(_CLOSE):]
                continue
            if start >= 0:
                out += self.buf[:start]
                self.buf = self.buf[start + len(_OPEN):]
                self.inside = True
                continue
            keep = max(_partial_suffix(self.buf, _OPEN), _partial_suffix(self.buf, _CLOSE))
            out += self.buf[:len(self.buf) - keep]
            self.buf = self.buf[len(self.buf) - keep:]
            break
        return self._trim(out)

    def flush(self) -> str:
        out = "" if self.inside else self.buf
        self.buf = ""
        return self._trim(out)

    def _trim(self, out: str) -> str:
        if not self.started:
            out = out.lstrip()
            self.started = bool(out)
        return out


@dataclass
class CheckResult:
    ok: bool
    message: str
    ms: int


def explain(e: Exception, cfg: BrainSettings) -> str:
    """A model-service error as a sentence the owner can act on."""
    if isinstance(e, (openai.AuthenticationError, openai.PermissionDeniedError)):
        return f"The model service rejected the key in {cfg.api_key_env}. Check that it's correct and still active."
    if isinstance(e, openai.NotFoundError):
        return f"The model {cfg.model} isn't available with this key."
    if isinstance(e, openai.RateLimitError):
        return "The model service says there are too many requests right now. Try again in a minute."
    if isinstance(e, openai.APITimeoutError):
        return f"The model didn't answer within {cfg.timeout_s:g} seconds."
    if isinstance(e, openai.APIConnectionError):
        return "I couldn't reach the model service. Check the internet connection."
    if isinstance(e, openai.BadRequestError):
        detail = str(getattr(e, "message", e)).splitlines()[0][:160]
        return f"The model service refused the request: {detail}"
    if isinstance(e, openai.APIStatusError):
        return f"The model service had an error (status {e.status_code}). Try again."
    return f"Something went wrong talking to the model: {e.__class__.__name__}."


class Brain:
    def __init__(self, cfg: BrainSettings, client: Any = None):
        self.cfg = cfg
        self._client = client

    @property
    def client(self) -> Any:
        if self._client is None:
            key = self.cfg.api_key()
            if not key:
                raise BrainError(f"{self.cfg.api_key_env} isn't set. Save your key as a Windows user "
                                 f"environment variable with that name, then restart Gnosis.")
            self._client = openai.AsyncOpenAI(
                base_url=self.cfg.base_url, api_key=key, max_retries=1,
                timeout=httpx.Timeout(self.cfg.timeout_s, connect=10.0))
        return self._client

    def _request(self, messages: list[dict[str, Any]], max_tokens: int | None = None) -> dict[str, Any]:
        req: dict[str, Any] = {
            "model": self.cfg.model, "messages": messages, "stream": True,
            "max_tokens": max_tokens or self.cfg.max_tokens, "temperature": self.cfg.temperature,
        }
        if not self.cfg.thinking:
            req["extra_body"] = {"chat_template_kwargs": {"enable_thinking": False}}
        return req

    async def stream(self, messages: list[dict[str, Any]], max_tokens: int | None = None) -> AsyncIterator[str]:
        """Yields the answer in pieces as the model writes it. Reasoning is never yielded."""
        client = self.client
        filt = ThinkFilter()
        try:
            stream = await client.chat.completions.create(**self._request(messages, max_tokens))
            async for chunk in stream:
                if not chunk.choices:
                    continue
                piece = getattr(chunk.choices[0].delta, "content", None)
                if piece:
                    out = filt.feed(piece)
                    if out:
                        yield out
        except openai.OpenAIError as e:
            raise BrainError(explain(e, self.cfg)) from e
        tail = filt.flush()
        if tail:
            yield tail

    async def check(self) -> CheckResult:
        """One tiny call, so a wrong key, model name or chat template shows up at start-up, not mid-conversation."""
        t0 = time.perf_counter()
        try:
            text = "".join([p async for p in self.stream(
                [{"role": "user", "content": "Reply with the single word OK."}], max_tokens=16)])
        except BrainError as e:
            return CheckResult(False, str(e), int((time.perf_counter() - t0) * 1000))
        ms = int((time.perf_counter() - t0) * 1000)
        if not text.strip():
            return CheckResult(False, f"{self.cfg.model} answered with nothing. Its settings may be wrong.", ms)
        return CheckResult(True, f"{self.cfg.model} is ready", ms)
