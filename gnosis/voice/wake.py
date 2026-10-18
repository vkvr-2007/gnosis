"""Wake word detection, fully on-device.

Two detectors with the same interface (`heard(block)` per 80 ms block, `reset()`):

- `PhraseWake` (the default) listens for "Hey Gnosis" by transcribing each short utterance with a tiny
  Whisper model. It needs no training, and it also catches a command said in the same breath
  ("Hey Gnosis, what time is it?"), which the loop then answers without a second listen.
- `WakeWord` runs an openWakeWord model, for a custom-trained `hey_gnosis.onnx` (see docs/wake-word.md).
  It's lighter on the CPU than transcribing, but needs that model first.
"""

from __future__ import annotations

import re
from concurrent.futures import Future, ThreadPoolExecutor
from pathlib import Path
from typing import Any, Callable

import numpy as np

from gnosis.voice.vad import Endpointer

WAKE_PHRASE = "hey gnosis"

# How Whisper tends to hear "Gnosis" (a silent G), and the greetings people put before it.
_GREETING = r"(?:hey|hay|hi|hiya|ok(?:ay)?|a|ay|eh|he)"
_NAME = (r"(?:g?nosis|g?noses|g?nossis|g?nosys|g?nosus|noesis|knows\s?is|no\s?sis|nose\s?is|"
         r"naus+is|g?nauses|gnostic|genesis)")
_WAKE = re.compile(rf"^\W*{_GREETING}\W+{_NAME}\b\W*(.*)$", re.I | re.S)


# Said while Gnosis is talking: "stop" ends the reply, "wait" ends it and listens. Always obeyed, even if
# Gnosis happens to be saying the same word.
_INTERRUPT = re.compile(r"^\W*(?:(stop|enough|be quiet|shut up|cancel|quiet)|(wait|hold on|hang on|pause|"
                        r"one (?:sec|second|moment)))(?:\W+(?:it|that|please|now|gnosis))*\W*$", re.I)


def match_interrupt(text: str) -> str | None:
    """"stop" or "wait" if `text` is only an interruption, else None."""
    m = _INTERRUPT.match(text or "")
    if not m:
        return None
    return "stop" if m.group(1) else "wait"


def _words(text: str) -> str:
    return " ".join(re.findall(r"[a-z0-9']+", text.lower()))


def is_echo(heard: str, spoken: str, threshold: float = 70.0) -> bool:
    """Whether the mic most likely picked up Gnosis's own voice: what it heard is (roughly) part of what
    Gnosis has been saying."""
    heard, spoken = _words(heard), _words(spoken)
    if not heard or not spoken:
        return False
    try:
        from rapidfuzz import fuzz

        return fuzz.partial_ratio(heard, spoken) >= threshold
    except ImportError:
        from difflib import SequenceMatcher

        match = SequenceMatcher(None, heard, spoken).find_longest_match(0, len(heard), 0, len(spoken))
        return match.size * 100 >= threshold * len(heard)


def match_wake_phrase(text: str) -> str | None:
    """None if `text` doesn't start with the wake phrase; otherwise what was said after it ("" if nothing)."""
    m = _WAKE.match(text or "")
    if not m:
        return None
    return m.group(1).strip()


class PhraseWake:
    """Hears "Hey Gnosis" by transcribing short utterances on the CPU, only while Gnosis is idle."""

    needs_quiet = True  # The voice loop pauses it while it's already listening for a request

    def __init__(self, transcribe: Callable[[np.ndarray], str] | None = None,
                 detector: Callable[[np.ndarray], bool] | None = None, model: str = "tiny.en",
                 max_utterance_s: float = 8.0):
        if transcribe is None:
            transcribe = _whisper(model)
        if detector is None:
            from gnosis.voice.vad import default_detector

            detector = default_detector()
        self._transcribe = transcribe
        self._detector = detector
        self._max_s = max_utterance_s
        self._pool = ThreadPoolExecutor(max_workers=1, thread_name_prefix="gnosis-wake")
        self._pending: Future | None = None
        self._pending_audio: np.ndarray | None = None
        self.last_audio: np.ndarray | None = None
        self._endpointer = self._new_endpointer()
        self.label = WAKE_PHRASE
        self.command = ""  # What followed the wake phrase in the same utterance
        self.last_heard = ""  # The last utterance transcribed while waiting (for the dashboard)
        # What `heard()` caught: "wake", or while Gnosis talks, "stop", "wait" or "barge" (a new request).
        self.kind = "wake"
        # Set by the voice loop, for telling the owner's voice from Gnosis's own coming back through the mic
        self.speaking: Callable[[], bool] = lambda: False
        self.spoken_text: Callable[[], str] = lambda: ""
        self.barge_in = False  # True: any new request (3+ words, not an echo) interrupts too, not only "stop"

    def _caught(self, text: str) -> bool:
        speaking = self.speaking()
        echo = speaking and is_echo(text, self.spoken_text())
        rest = match_wake_phrase(text)
        if rest is not None and not echo:
            self.kind, self.command = "wake", rest
            return True
        if not speaking:
            return False
        interrupt = match_interrupt(text)
        if interrupt:
            self.kind, self.command = interrupt, ""
            return True
        if self.barge_in and not echo and len(_words(text).split()) >= 3:
            self.kind, self.command = "barge", text.strip()
            return True
        return False

    def check_finished(self, audio: np.ndarray) -> Future:
        """Future[bool]: does what's been said so far sound like a whole request? (For ending a listen
        sooner.) Uses the same tiny model, which is idle while Gnosis listens for a request."""
        from gnosis.voice.vad import sounds_finished

        return self._pool.submit(lambda: sounds_finished(self._safe_transcribe(audio)))

    def _new_endpointer(self) -> Endpointer:
        # A shorter pause than for a request: "Hey Gnosis" is usually followed by a breath.
        return Endpointer(self._detector, end_silence_s=0.5, start_timeout_s=float("inf"),
                          max_s=self._max_s, min_speech_s=0.24)

    def heard(self, block: np.ndarray) -> bool:
        if self._pending is not None and self._pending.done():
            text, self._pending = self._pending.result(), None
            self.last_heard = text
            if self._caught(text):
                self.last_audio = self._pending_audio  # Voice ID checks a same-breath command too
                return True
        if self._endpointer.feed(block) == "done":
            audio = self._endpointer.audio()
            self._endpointer = self._new_endpointer()
            if self._pending is None:  # Still busy with the last one: drop this utterance
                self._pending_audio = audio
                self._pending = self._pool.submit(self._safe_transcribe, audio)
        return False

    def _safe_transcribe(self, audio: np.ndarray) -> str:
        try:
            return self._transcribe(audio)
        except Exception:
            return ""

    def take_command(self) -> str:
        command, self.command = self.command, ""
        return command

    def reset(self) -> None:
        self._endpointer = self._new_endpointer()
        self._pending = None
        self.command = ""


def _whisper(model: str) -> Callable[[np.ndarray], str]:
    from faster_whisper import WhisperModel

    whisper = WhisperModel(model, device="cpu", compute_type="int8")

    def transcribe(audio: np.ndarray) -> str:
        if audio.dtype == np.int16:
            audio = audio.astype(np.float32) / 32768.0
        # The prompt nudges Whisper to spell the name the way the matcher expects.
        segments, _ = whisper.transcribe(audio, language="en", beam_size=1, vad_filter=False,
                                         condition_on_previous_text=False, initial_prompt="Hey Gnosis.")
        return " ".join(s.text.strip() for s in segments).strip()

    return transcribe


class WakeWord:
    def __init__(self, model: str, threshold: float = 0.5, cooldown_blocks: int = 15):
        """`model` is a path to a custom .onnx model, or the name of one bundled with openWakeWord."""
        from openwakeword import utils
        from openwakeword.model import Model

        if Path(model).suffix == ".onnx":
            if not Path(model).exists():
                raise FileNotFoundError(f"Wake word model not found: {model}")
            utils.download_models([])  # Feature models only
        else:
            utils.download_models([model])
        self.model = Model(wakeword_models=[model], inference_framework="onnx")
        self.label = Path(model).stem if Path(model).suffix else model
        self.threshold = threshold
        self.cooldown_blocks = cooldown_blocks
        self._cooldown = 0

    def heard(self, block: np.ndarray) -> bool:
        """Feeds one 80 ms block; True when the wake word was just spoken."""
        scores = self.model.predict(block)
        if self._cooldown > 0:
            self._cooldown -= 1
            return False
        if max(scores.values(), default=0.0) >= self.threshold:
            self._cooldown = self.cooldown_blocks
            self.model.reset()
            return True
        return False

    def reset(self) -> None:
        self.model.reset()


def load_wake(cfg: dict[str, Any]) -> PhraseWake | WakeWord:
    """openWakeWord when a model is configured, otherwise the "Hey Gnosis" phrase detector."""
    if cfg.get("wake_model"):
        return WakeWord(str(cfg["wake_model"]), float(cfg.get("wake_threshold", 0.5)))
    return PhraseWake(model=cfg.get("wake_stt_model", "tiny.en"))
