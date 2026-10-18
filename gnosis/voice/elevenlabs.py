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


def key_problem(key: str | None, client: httpx.Client | None = None) -> str | None:
    """Why ElevenLabs will refuse this key, or None if it looks usable (or ElevenLabs can't be reached:
    then the per-sentence fallback handles it)."""
    if not key:
        return f"{KEY_ENV} isn't set"
    try:
        r = (client or httpx.Client(timeout=10)).get(f"{API}/user", headers={"xi-api-key": key})
    except httpx.HTTPError:
        return None
    if r.status_code < 400:
        return None
    try:
        detail = r.json().get("detail") or {}
    except ValueError:
        return None
    # A key without the user_read permission also fails here, but it can still speak; only a bad key counts.
    if isinstance(detail, dict) and detail.get("code") == "invalid_api_key":
        return detail.get("message") or "the API key was rejected"
    return None


def voice_problem(key: str, voice: str, client: httpx.Client | None = None) -> str | None:
    """Why ElevenLabs won't speak with this voice (e.g. a library voice on a free plan), or None. A failed
    connection counts as no problem: the per-sentence fallback handles that."""
    try:
        r = (client or httpx.Client(timeout=15)).post(
            f"{API}/text-to-speech/{voice}", params={"output_format": "pcm_16000"},
            headers={"xi-api-key": key}, json={"text": "Hi.", "model_id": "eleven_flash_v2_5"})
    except httpx.HTTPError:
        return None
    if r.status_code < 400:
        return None
    try:
        detail = r.json().get("detail") or {}
    except ValueError:
        detail = {}
    message = detail.get("message") if isinstance(detail, dict) else str(detail)
    return message or f"HTTP {r.status_code}"


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


def warm(*voices: Any) -> None:
    """Opens the connection to ElevenLabs ahead of time: the very first request in a process spends
    seconds on DNS and TLS (5.4 s measured on the laptop, then 0.2-0.4 s)."""
    for v in voices:
        if isinstance(v, (ElevenLabsSTT, ElevenLabsTTS)):
            try:
                v.client.get(f"{API}/models", headers={"xi-api-key": v.key}, timeout=10)
            except httpx.HTTPError:
                pass  # The first real request falls back if ElevenLabs is down


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
