"""The core: takes questions, streams answers from the brain, and reports everything as events.

Every event carries the id of the question it belongs to ("ask"), so text from a stopped answer can never
show up under the next one. The window, the speed bench and the tests all drive this same class.

Events (dicts with a "type"):
  ready        {ok, model, message, ms}        the model check at start-up
  started      {ask, text}                     a question was accepted
  text         {ask, delta}                    the next piece of the answer
  done         {ask, text, timings}            the full answer, with first_text_ms, first_sentence_ms, total_ms
  interrupted  {ask, text}                     stopped by the owner or by a newer question; text = what was said
  error        {ask, message}                  a plain sentence saying what went wrong
"""

from __future__ import annotations

import asyncio
import re
import time
import uuid
from typing import Any, Callable

from gnosis.brain import Brain, BrainError, CheckResult
from gnosis.conversation import Conversation
from gnosis.identity import Identity
from gnosis.journal import Journal
from gnosis.persona import system_prompt
from gnosis.settings import Settings

Emit = Callable[[dict[str, Any]], None]
_SENTENCE_END = re.compile(r"[.!?](\s|$)")
_INTERRUPT_WAIT_S = 0.4


class Core:
    def __init__(self, settings: Settings, identity: Identity, brain: Brain | None = None,
                 emit: Emit | None = None, journal: Journal | None = None,
                 conversation: Conversation | None = None):
        self.settings = settings
        self.identity = identity
        self.brain = brain or Brain(settings.brain)
        self.emit_fn = emit or (lambda ev: None)
        self.journal = journal or Journal(settings.data_dir)
        self.conversation = conversation or Conversation(
            settings.data_dir, settings.conversation.history_messages, settings.conversation.timezone)
        self.system = system_prompt(identity)
        self.check: CheckResult | None = None
        self.current: tuple[str, asyncio.Task] | None = None
        self.last_timings: dict[str, int] = {}

    def emit(self, ev: dict[str, Any]) -> None:
        try:
            self.emit_fn(ev)
        except Exception as e:  # A closed window must not break the answer
            self.journal.log("dropped", reason=f"emit failed: {e.__class__.__name__}", event=ev.get("type"))

    async def start(self) -> CheckResult:
        self.check = await self.brain.check()
        self.journal.log("model_check", ok=self.check.ok, message=self.check.message, ms=self.check.ms)
        self.emit({"type": "ready", "ok": self.check.ok, "model": self.settings.brain.model,
                   "message": self.check.message, "ms": self.check.ms})
        return self.check

    async def ask(self, text: str) -> str:
        """Accepts a question and starts answering it. A question already being answered is stopped first."""
        text = text.strip()
        if not text:
            raise ValueError("empty question")
        await self.interrupt()
        ask_id = uuid.uuid4().hex[:8]
        messages = self.conversation.for_model(self.system, text)
        self.conversation.add("user", text, ask=ask_id)
        self.journal.log("question", ask=ask_id, text=text)
        self.emit({"type": "started", "ask": ask_id, "text": text})
        task = asyncio.create_task(self._answer(ask_id, messages))
        self.current = (ask_id, task)
        return ask_id

    async def interrupt(self) -> str | None:
        """Stops the answer in progress, if any, and waits briefly for it to wind down."""
        if not self.current:
            return None
        ask_id, task = self.current
        self.current = None
        if not task.done():
            task.cancel()
            try:
                await asyncio.wait_for(asyncio.shield(task), _INTERRUPT_WAIT_S)
            except (asyncio.CancelledError, asyncio.TimeoutError):
                pass
        return ask_id

    async def wait(self) -> None:
        """Waits until the current answer is finished (for the bench and tests)."""
        if self.current:
            try:
                await self.current[1]
            except asyncio.CancelledError:
                pass

    async def _answer(self, ask_id: str, messages: list[dict[str, Any]]) -> None:
        t0 = time.perf_counter()
        ms = lambda: int((time.perf_counter() - t0) * 1000)
        parts: list[str] = []
        timings: dict[str, int] = {}
        try:
            async for piece in self.brain.stream(messages):
                if "first_text_ms" not in timings:
                    timings["first_text_ms"] = ms()
                parts.append(piece)
                if "first_sentence_ms" not in timings and _SENTENCE_END.search("".join(parts)):
                    timings["first_sentence_ms"] = ms()
                self.emit({"type": "text", "ask": ask_id, "delta": piece})
        except asyncio.CancelledError:
            said = "".join(parts).strip()
            if said:
                self.conversation.add("assistant", said, ask=ask_id, interrupted=True)
            self.journal.log("interrupted", ask=ask_id, said=said, ms=ms())
            self.emit({"type": "interrupted", "ask": ask_id, "text": said})
            raise
        except BrainError as e:
            self.journal.log("error", ask=ask_id, message=str(e), ms=ms())
            self.emit({"type": "error", "ask": ask_id, "message": str(e)})
            return
        except Exception as e:  # Never leave the window waiting on an answer that won't come
            message = f"Something went wrong inside Gnosis: {e.__class__.__name__}."
            self.journal.log("error", ask=ask_id, message=message, detail=repr(e)[:300], ms=ms())
            self.emit({"type": "error", "ask": ask_id, "message": message})
            return
        finally:
            if self.current and self.current[0] == ask_id:
                self.current = None
        answer = "".join(parts).strip()
        timings["total_ms"] = ms()
        timings.setdefault("first_text_ms", timings["total_ms"])
        timings.setdefault("first_sentence_ms", timings["total_ms"])
        self.last_timings = timings
        if not answer:
            message = "The model sent back an empty answer. Try asking again."
            self.journal.log("error", ask=ask_id, message=message, **timings)
            self.emit({"type": "error", "ask": ask_id, "message": message})
            return
        self.conversation.add("assistant", answer, ask=ask_id)
        self.journal.log("answer", ask=ask_id, text=answer, **timings)
        self.emit({"type": "done", "ask": ask_id, "text": answer, "timings": timings})

    def new_chat(self) -> None:
        self.conversation.clear()
        self.journal.log("new_chat")

    def history(self) -> list[dict[str, Any]]:
        return [{"role": m["role"], "content": m["content"], "at": m.get("at", ""),
                 "interrupted": bool(m.get("interrupted"))} for m in self.conversation.messages]

    def status(self) -> dict[str, Any]:
        return {
            "name": self.identity.name,
            "model": self.settings.brain.model,
            "endpoint": self.settings.brain.base_url,
            "key_set": bool(self.settings.brain.api_key()),
            "key_env": self.settings.brain.api_key_env,
            "check": vars(self.check) if self.check else None,
            "busy": bool(self.current),
            "last_timings": self.last_timings,
            "data_dir": str(self.settings.data_dir),
        }
