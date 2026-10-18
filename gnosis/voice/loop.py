"""The voice loop: wake word, listen, understand, verify the speaker, act, speak.

Saying the wake word while Gnosis is talking interrupts it (barge-in). After Gnosis answers it keeps
listening briefly for a follow-up, so you don't have to say the wake word again.
"""

from __future__ import annotations

import asyncio
import itertools
import queue
import re
import threading
from dataclasses import dataclass
from typing import Any, AsyncIterator, Callable, Iterator

import numpy as np

from gnosis.voice.audio import chime
from gnosis.voice.vad import Endpointer

_STOP_WORDS = re.compile(r"^\W*(stop|cancel|never ?mind|be quiet|shut up|nothing)\W*$", re.I)
# Said when a tool starts and nothing has been said yet, so the owner knows they were heard.
_ON_IT = ("On it.", "One moment.", "Sure, on it.", "Give me a second.")
# Tools fast enough that the answer itself comes before an "On it" would be useful.
_QUICK_TOOLS = {"get_time", "system_info", "search_memory", "remember", "forget", "list_reminders",
                "list_windows", "load_skill"}


class _Sentences:
    """Turns an answer streaming in as text into whole sentences for the speaker.

    The speaker plays on its own thread, so sentences cross over through a thread-safe queue;
    `finish()` must always be called, or the speaker waits for more.
    """

    _END = re.compile(r"(?<=[.!?…])\s+|\n+")

    def __init__(self) -> None:
        self.buffer = ""
        self.queue: queue.Queue[str | None] = queue.Queue()
        self.spoken: list[str] = []
        self.cancelled = False

    def feed(self, delta: str | None) -> bool:
        """Adds streamed text (None drops the unfinished sentence). True once a sentence is ready."""
        if delta is None:
            self.buffer = ""
            return bool(self.spoken)
        self.buffer += delta
        *done, self.buffer = self._END.split(self.buffer)
        for sentence in (s.strip() for s in done):
            if sentence:
                self.spoken.append(sentence)
                self.queue.put(sentence)
        return bool(self.spoken)

    def finish(self) -> None:
        if self.buffer.strip():
            self.spoken.append(self.buffer.strip())
            self.queue.put(self.buffer.strip())
        self.buffer = ""
        self.queue.put(None)

    def cancel(self) -> None:
        """Stops preparing speech (the owner interrupted)."""
        self.cancelled = True
        self.queue.put(None)

    def chunks(self, tts: Any) -> Iterator[Any]:
        """The audio, sentence by sentence. A helper thread prepares the next sentence while this one
        plays, so there's no gap while ElevenLabs works on it."""
        ready: queue.Queue[Any] = queue.Queue()
        done = object()

        def prepare() -> None:
            try:
                while not self.cancelled and (sentence := self.queue.get()) is not None:
                    for chunk in tts.synthesize(sentence):
                        if self.cancelled:
                            break
                        ready.put(chunk)
            except Exception as e:
                ready.put(e)
            ready.put(done)

        threading.Thread(target=prepare, name="gnosis-speech", daemon=True).start()
        while (chunk := ready.get()) is not done:
            if isinstance(chunk, Exception):
                raise chunk
            if self.cancelled:
                return
            yield chunk

    def spoken_any_of(self, answer: str) -> bool:
        return any(s in answer for s in self.spoken)


@dataclass
class VoiceConfig:
    follow_up_s: float = 4.0   # How long to listen for a follow-up after answering, without the wake word
    chime: bool = True
    background_after_s: float = 12.0  # Longer tasks carry on in the background and announce when done


class VoiceLoop:
    def __init__(self, *, wake: Any, stt: Any, tts: Any, speaker: Any, orchestrator: Any, events: Any,
                 detector: Callable[[np.ndarray], bool], voice_id: Any | None = None,
                 config: VoiceConfig | None = None, on_audio_drain: Callable[[], None] | None = None,
                 on_stop_command: Callable[[], Any] | None = None,
                 on_error: Callable[[str], None] | None = None):
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
        self.on_stop_command = on_stop_command  # "Stop" also halts running tasks, like the kill switch
        self.on_error = on_error  # Writes voice problems to the audit log
        self.state = "idle"
        self._endpointer: Endpointer | None = None
        self._woken = False  # This listen started with the wake word (not a follow-up)
        self._busy = asyncio.Lock()
        self._play_lock = asyncio.Lock()  # "On it" and the answer take turns at the speaker
        self._tasks: set[asyncio.Task] = set()
        self._sentences: _Sentences | None = None  # The answer being spoken now
        self._recently_said = ""  # For telling Gnosis's own voice (echo) from the owner's
        self._on_it = itertools.cycle(_ON_IT)
        if hasattr(wake, "speaking"):
            wake.speaking = lambda: self.speaker.speaking
            wake.spoken_text = lambda: self._recently_said

    async def _set_state(self, state: str) -> None:
        if state != self.state:
            self.state = state
            await self.events.publish("voice_state", state=state)

    async def _error(self, error: str) -> None:
        if self.on_error:
            self.on_error(error)
        await self.events.publish("voice_error", error=error)

    def _spawn(self, coro) -> None:
        task = asyncio.create_task(coro)
        self._tasks.add(task)
        task.add_done_callback(self._tasks.discard)

    def _listen(self, start_timeout_s: float = 5.0) -> None:
        # Silence plus words: a short pause ends a sentence that sounds finished, a trailing "and..." waits.
        self._endpointer = Endpointer(self.detector, start_timeout_s=start_timeout_s,
                                      check=getattr(self.wake, "check_finished", None))

    def _hush(self) -> None:
        """Stops talking now: the current sentence and the ones being prepared."""
        self.speaker.stop()
        if self._sentences is not None:
            self._sentences.cancel()

    async def _start_listening(self) -> None:
        self._listen()
        self._woken = True
        await self._set_state("listening")
        if self.config.chime:
            self._spawn(self._play([chime()]))

    async def push_to_talk(self) -> None:
        """Ctrl+Space (or the face in the window): listen now, interrupting Gnosis if it's talking."""
        if self.speaker.speaking:
            self._hush()
        if self._endpointer is None:
            await self._start_listening()

    async def _play(self, chunks) -> bool:
        async with self._play_lock:
            return await self.speaker.play(chunks)

    def _said(self, text: str) -> None:
        self._recently_said = (self._recently_said + " " + text)[-600:]

    async def run(self, blocks: AsyncIterator[np.ndarray]) -> None:
        async for block in blocks:
            await self.feed(block)

    async def feed(self, block: np.ndarray) -> None:
        # A transcribing wake detector would hear the request itself as well, so it rests meanwhile.
        wake_listening = self._endpointer is None or not getattr(self.wake, "needs_quiet", False)
        if wake_listening and self.wake.heard(block):
            kind = getattr(self.wake, "kind", "wake")
            if self.speaker.speaking:
                self._hush()  # Barge-in
            take = getattr(self.wake, "take_command", None)
            command = take() if take else ""
            if kind == "stop":
                await self.events.publish("voice_heard", text="stop", owner=True, score=None)
                if not self._busy.locked() and self._endpointer is None:
                    await self._set_state("idle")  # Otherwise the reply that was cut off sets it
                return
            if kind == "wait":
                await self.events.publish("voice_heard", text="wait", owner=True, score=None)
                await self._start_listening()
                return
            if command:
                # "Hey Gnosis, what time is it?" in one breath, or a new request said over Gnosis:
                # answer it, no second listen.
                self._woken = False
                await self._set_state("thinking")
                self._spawn(self._respond(getattr(self.wake, "last_audio", None), text=command))
                return
            await self._start_listening()
            return
        if self._endpointer is None:
            return
        result = self._endpointer.feed(block)
        if result == "timeout":
            self._endpointer = None
            if self._woken and not self._busy.locked():
                # Woken but heard nothing: say so, instead of going quiet (usually the mic is too quiet).
                self._woken = False
                self._spawn(self._feedback("I didn't hear anything. Say the wake word and try again.",
                                           "no speech after the wake word"))
                return
            await self._set_state("idle" if not self._busy.locked() else "thinking")
        elif result == "done":
            audio = self._endpointer.audio()
            self._endpointer = None
            self._woken = False
            self._spawn(self._respond(audio))

    async def _feedback(self, spoken: str, error: str) -> None:
        await self._error(error)
        async with self._busy:
            await self._speak(spoken)

    async def _speak(self, text: str) -> None:
        """Speaks without the follow-up window; used for problems, so a failure here is only reported."""
        try:
            await self._set_state("speaking")
            self._said(text)
            await self._play(self.tts.synthesize(text))
            if self.on_audio_drain:
                self.on_audio_drain()
        except Exception as e:
            await self._error(f"Couldn't speak: {type(e).__name__}: {e}")
        if self._endpointer is None:
            await self._set_state("idle")

    async def _respond(self, audio: np.ndarray | None, text: str | None = None) -> None:
        try:
            await self._respond_to(audio, text)
        except Exception as e:
            # Anything that breaks between hearing and answering must not leave the owner in silence.
            await self._error(f"{type(e).__name__}: {e}")
            await self._speak("Sorry, something went wrong. The dashboard shows what happened.")

    async def _respond_to(self, audio: np.ndarray | None, text: str | None = None) -> None:
        async with self._busy:
            await self._set_state("thinking")
            if text is None:
                text = (await asyncio.to_thread(self.stt.transcribe, audio)).strip()
            if not text:
                await self._error("Speech recognition returned nothing")
                await self._speak("Sorry, I didn't catch that.")
                return
            if _STOP_WORDS.match(text):
                self.speaker.stop()
                if self.on_stop_command:
                    result = self.on_stop_command()
                    if asyncio.iscoroutine(result):
                        await result
                await self.events.publish("voice_heard", text=text, owner=True, score=None)
                await self._set_state("idle")
                return

            owner, score = True, None
            if self.voice_id is not None:
                verdict = await asyncio.to_thread(self.voice_id.verify, audio)
                owner, score = verdict.is_owner, round(verdict.score, 3)
            await self.events.publish("voice_heard", text=text, owner=owner, score=score)

            sentences = self._sentences = _Sentences()
            first_sentence = asyncio.Event()
            said_on_it = False

            async def on_text(delta: str | None) -> None:
                if sentences.feed(delta):
                    first_sentence.set()

            async def on_tool(name: str) -> None:
                nonlocal said_on_it
                if not first_sentence.is_set():
                    await self._set_state("working")
                if not said_on_it and not first_sentence.is_set() and name not in _QUICK_TOOLS:
                    said_on_it = True
                    line = next(self._on_it)
                    self._said(line)
                    self._spawn(self._play(self.tts.synthesize(line)))

            work = asyncio.create_task(self.orchestrator.handle(text, "voice", owner=owner, on_text=on_text,
                                                                on_tool=on_tool))
            waiter = asyncio.create_task(first_sentence.wait())
            await asyncio.wait({work, waiter}, timeout=self.config.background_after_s,
                               return_when=asyncio.FIRST_COMPLETED)
            waiter.cancel()
            if first_sentence.is_set():
                # Speak each sentence as it's written instead of waiting for the whole answer.
                await self._set_state("speaking")

                def spoken_chunks():
                    for chunk in sentences.chunks(self.tts):
                        self._recently_said = (" ".join(sentences.spoken))[-600:]
                        yield chunk

                playing = asyncio.create_task(self._play(spoken_chunks()))
                try:
                    answer = await self._answer_of(work)
                finally:
                    sentences.finish()
                finished = await playing and not sentences.cancelled
                if not sentences.spoken_any_of(answer) and finished:
                    self._said(answer)
                    finished = await self._play(self.tts.synthesize(answer))  # e.g. an error message
                await self._after_speaking(finished)
                return
            if work.done():
                answer = await self._answer_of(work)
            else:
                # Keep the voice free while a long task runs; it speaks up when the task finishes.
                answer = ("I'll tell you when it's done." if said_on_it
                          else "I'm on it. I'll tell you when it's done.")
                self._tasks.add(work)
                work.add_done_callback(self._tasks.discard)
                work.add_done_callback(lambda t: self._spawn(self._announce(t)))
            await self._speak_and_follow_up(answer)

    async def _answer_of(self, work: asyncio.Task) -> str:
        await asyncio.wait({work})  # Waits for the whole answer; the first sentence is often spoken long before
        try:
            return work.result()
        except asyncio.CancelledError:
            return "Stopped."
        except Exception as e:
            await self._error(f"{type(e).__name__}: {e}")
            return "Sorry, I couldn't reach my brain just now."

    async def _announce(self, work: asyncio.Task) -> None:
        await self.say(await self._answer_of(work))

    async def say(self, text: str) -> None:
        """Speaks something Gnosis wasn't asked just now (a finished task, a reminder) once it won't
        interrupt the owner."""
        while self._endpointer is not None:  # Don't talk over someone who's speaking
            await asyncio.sleep(0.2)
        async with self._busy:
            await self._speak_and_follow_up(text)

    async def _speak_and_follow_up(self, answer: str) -> None:
        await self._set_state("speaking")
        self._said(answer)
        await self._after_speaking(await self._play(self.tts.synthesize(answer)))

    async def _after_speaking(self, finished: bool) -> None:
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
            # Gathering finished tasks doesn't yield; let their callbacks run (they remove them from
            # the set, and a finished background task spawns its announcement).
            await asyncio.sleep(0)
