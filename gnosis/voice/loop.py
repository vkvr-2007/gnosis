"""The voice loop: wake word, listen, understand, verify the speaker, act, speak.

Saying the wake word while Gnosis is talking interrupts it (barge-in). After Gnosis answers it keeps
listening briefly for a follow-up, so you don't have to say the wake word again.
"""

from __future__ import annotations

import asyncio
import re
from dataclasses import dataclass
from typing import Any, AsyncIterator, Callable

import numpy as np

from gnosis.voice.audio import chime
from gnosis.voice.vad import Endpointer

_STOP_WORDS = re.compile(r"^\W*(stop|cancel|never ?mind|be quiet|shut up|nothing)\W*$", re.I)


@dataclass
class VoiceConfig:
    follow_up_s: float = 4.0   # How long to listen for a follow-up after answering, without the wake word
    chime: bool = True


class VoiceLoop:
    def __init__(self, *, wake: Any, stt: Any, tts: Any, speaker: Any, orchestrator: Any, events: Any,
                 detector: Callable[[np.ndarray], bool], voice_id: Any | None = None,
                 config: VoiceConfig | None = None, on_audio_drain: Callable[[], None] | None = None):
        self.wake = wake
        self.stt = stt
        self.tts = tts
        self.speaker = speaker
        self.orchestrator = orchestrator
        self.events = events
        self.detector = detector
        self.voice_id = voice_id
        self.config = config or VoiceConfig()
        self.on_audio_drain = on_audio_drain
        self.state = "idle"
        self._endpointer: Endpointer | None = None
        self._busy = asyncio.Lock()
        self._tasks: set[asyncio.Task] = set()

    async def _set_state(self, state: str) -> None:
        if state != self.state:
            self.state = state
            await self.events.publish("voice_state", state=state)

    def _spawn(self, coro) -> None:
        task = asyncio.create_task(coro)
        self._tasks.add(task)
        task.add_done_callback(self._tasks.discard)

    def _listen(self, start_timeout_s: float = 5.0) -> None:
        self._endpointer = Endpointer(self.detector, start_timeout_s=start_timeout_s)

    async def run(self, blocks: AsyncIterator[np.ndarray]) -> None:
        async for block in blocks:
            await self.feed(block)

    async def feed(self, block: np.ndarray) -> None:
        if self.wake.heard(block):
            if self.speaker.speaking:
                self.speaker.stop()  # Barge-in
            self._listen()
            await self._set_state("listening")
            if self.config.chime:
                self._spawn(self.speaker.play([chime()]))
            return
        if self._endpointer is None:
            return
        result = self._endpointer.feed(block)
        if result == "timeout":
            self._endpointer = None
            await self._set_state("idle" if not self._busy.locked() else "thinking")
        elif result == "done":
            audio = self._endpointer.audio()
            self._endpointer = None
            self._spawn(self._respond(audio))

    async def _respond(self, audio: np.ndarray) -> None:
        async with self._busy:
            await self._set_state("thinking")
            text = (await asyncio.to_thread(self.stt.transcribe, audio)).strip()
            if not text:
                await self._set_state("idle")
                return
            if _STOP_WORDS.match(text):
                self.speaker.stop()
                await self.events.publish("voice_heard", text=text, owner=True, score=None)
                await self._set_state("idle")
                return

            owner, score = True, None
            if self.voice_id is not None:
                verdict = await asyncio.to_thread(self.voice_id.verify, audio)
                owner, score = verdict.is_owner, round(verdict.score, 3)
            await self.events.publish("voice_heard", text=text, owner=owner, score=score)

            try:
                answer = await self.orchestrator.handle(text, "voice", owner=owner)
            except Exception as e:
                answer = "Sorry, I couldn't reach my brain just now."
                await self.events.publish("voice_error", error=f"{type(e).__name__}: {e}")

            await self._set_state("speaking")
            finished = await self.speaker.play(self.tts.synthesize(answer))
            if self.on_audio_drain:
                self.on_audio_drain()  # Don't treat Gnosis's own voice as the next request.
            if finished and self.config.follow_up_s > 0 and self._endpointer is None:
                self._listen(start_timeout_s=self.config.follow_up_s)
                await self._set_state("listening")
            elif self._endpointer is None:
                await self._set_state("idle")

    async def drain(self) -> None:
        """Waits for in-flight responses (used in tests and on shutdown)."""
        while self._tasks:
            await asyncio.gather(*list(self._tasks), return_exceptions=True)
