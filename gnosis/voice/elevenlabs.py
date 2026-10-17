"""ElevenLabs speech-to-text (Scribe) and voices, as an opt-in alternative to the on-device models.

With these on, what you say after the wake word, and Gnosis's spoken replies, go to ElevenLabs. The wake
word itself always runs on the laptop, so nothing is sent until you say it. If ElevenLabs can't be
reached, Gnosis falls back to the on-device model for that sentence.
"""

from __future__ import annotations

import io
import os
import wave
from typing import Any, Iterator

import httpx
import numpy as np

from gnosis.voice.tts import AudioChunk, speakable

API = "https://api.elevenlabs.io/v1"
KEY_ENV = "ELEVENLABS_API_KEY"
DEFAULT_VOICE = "JBFqnCBsd6RMkjVDRZzb"  # "George", one of ElevenLabs' built-in voices
_RATE = 16_000


def api_key() -> str | None:
    return os.environ.get(KEY_ENV) or None


def to_wav(audio: np.ndarray, rate: int = _RATE) -> bytes:
    if audio.dtype != np.int16:
        audio = (np.clip(audio, -1, 1) * 32767).astype(np.int16)
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes(audio.tobytes())
    return buf.getvalue()


class ElevenLabsSTT:
    def __init__(self, key: str, model: str = "scribe_v1", fallback: Any = None,
                 client: httpx.Client | None = None):
        self.key, self.model, self.fallback = key, model, fallback
        self.client = client or httpx.Client(timeout=30)

    def transcribe_bytes(self, data: bytes, filename: str = "audio.wav") -> str:
        r = self.client.post(f"{API}/speech-to-text", headers={"xi-api-key": self.key},
                             data={"model_id": self.model, "language_code": "en", "tag_audio_events": "false"},
                             files={"file": (filename, data)})
        r.raise_for_status()
        return (r.json().get("text") or "").strip()

    def transcribe(self, audio: np.ndarray) -> str:
        """`audio` is 16 kHz mono int16 or float32, like the on-device SpeechToText."""
        try:
            return self.transcribe_bytes(to_wav(audio))
        except httpx.HTTPError:
            if self.fallback is None:
                raise
            return self.fallback.transcribe(audio)


class ElevenLabsTTS:
    def __init__(self, key: str, voice: str = DEFAULT_VOICE, model: str = "eleven_flash_v2_5",
                 fallback: Any = None, client: httpx.Client | None = None):
        self.key, self.voice, self.model, self.fallback = key, voice, model, fallback
        self.client = client or httpx.Client(timeout=30)

    def synthesize(self, text: str) -> Iterator[AudioChunk]:
        spoken = speakable(text)
        if not spoken:
            return
        try:
            # Streamed as raw 16 kHz PCM, so playback starts before the whole reply is ready.
            with self.client.stream("POST", f"{API}/text-to-speech/{self.voice}/stream",
                                    params={"output_format": "pcm_16000"},
                                    headers={"xi-api-key": self.key},
                                    json={"text": spoken, "model_id": self.model}) as r:
                r.raise_for_status()
                leftover = b""
                for part in r.iter_bytes(8192):
                    part = leftover + part
                    cut = len(part) - len(part) % 2
                    leftover = part[cut:]
                    if cut:
                        yield np.frombuffer(part[:cut], dtype=np.int16).astype(np.float32) / 32768.0, _RATE
        except httpx.HTTPError:
            if self.fallback is None:
                raise
            yield from self.fallback.synthesize(text)


def load_stt(cfg: dict[str, Any], local: Any) -> Any:
    """The speech-to-text the settings ask for. `local` builds the on-device one (called only if needed)."""
    key = api_key()
    if cfg.get("stt") == "elevenlabs" and key:
        return ElevenLabsSTT(key, cfg.get("elevenlabs_stt_model", "scribe_v1"), fallback=_Lazy(local))
    return local()


def wrap_tts(cfg: dict[str, Any], local: Any) -> Any:
    key = api_key()
    if cfg.get("tts") == "elevenlabs" and key:
        return ElevenLabsTTS(key, cfg.get("elevenlabs_voice") or DEFAULT_VOICE,
                             cfg.get("elevenlabs_tts_model", "eleven_flash_v2_5"), fallback=local)
    return local


class _Lazy:
    """Builds the on-device fallback the first time it's needed, so it isn't loaded when ElevenLabs works."""

    def __init__(self, make):
        self.make, self.obj = make, None

    def transcribe(self, audio):
        if self.obj is None:
            self.obj = self.make()
        return self.obj.transcribe(audio)
