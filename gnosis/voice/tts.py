"""Text to speech: Piper on-device voices, with the built-in Windows voice as a fallback."""

from __future__ import annotations

import re
from pathlib import Path
from typing import Iterator, Protocol

import numpy as np

AudioChunk = tuple[np.ndarray, int]  # (float32 samples, sample rate)


class TTS(Protocol):
    def synthesize(self, text: str) -> Iterator[AudioChunk]: ...


def speakable(text: str) -> str:
    """Strips markdown and links that sound wrong when read aloud."""
    text = re.sub(r"```[\s\S]*?```", " (code shown on screen) ", text)
    text = re.sub(r"\[([^\]]+)\]\([^)]+\)", r"\1", text)
    text = re.sub(r"https?://\S+", "the link", text)
    text = re.sub(r"\s*\[#\d+\]", "", text)  # Memory fact ids

    text = re.sub(r"[*_`#>|]", "", text)
    return re.sub(r"\s+", " ", text).strip()


class PiperTTS:
    def __init__(self, voice_path: str | Path, length_scale: float = 1.0):
        from piper import PiperVoice, SynthesisConfig

        self.voice = PiperVoice.load(str(voice_path))
        self.config = SynthesisConfig(length_scale=length_scale)

    def synthesize(self, text: str) -> Iterator[AudioChunk]:
        # Piper yields one chunk per sentence, so playback starts after the first sentence is ready.
        for chunk in self.voice.synthesize(speakable(text), syn_config=self.config):
            yield chunk.audio_float_array.astype(np.float32), chunk.sample_rate


class WindowsTTS:
    """Uses the voice built into Windows (System.Speech) when no Piper voice is downloaded.

    It runs through PowerShell, so it works from any thread with no extra packages.
    """

    _SCRIPT = (
        "Add-Type -AssemblyName System.Speech;"
        "$s = New-Object System.Speech.Synthesis.SpeechSynthesizer;"
        "$s.Rate = {rate};"
        "$s.SetOutputToWaveFile($env:GNOSIS_TTS_OUT);"
        "$s.Speak($env:GNOSIS_TTS_TEXT);"
        "$s.Dispose()"
    )

    def __init__(self, rate: int = 1):
        self.rate = rate  # -10 (slow) to 10 (fast)

    def synthesize(self, text: str) -> Iterator[AudioChunk]:
        import os
        import subprocess
        import tempfile
        import wave

        with tempfile.TemporaryDirectory() as d:
            path = Path(d) / "say.wav"
            # Text goes in through an environment variable, so nothing in it can be run as a command.
            env = {**os.environ, "GNOSIS_TTS_OUT": str(path), "GNOSIS_TTS_TEXT": speakable(text)}
            subprocess.run(["powershell", "-NoProfile", "-NonInteractive", "-Command",
                            self._SCRIPT.format(rate=int(self.rate))],
                           env=env, check=True, capture_output=True, timeout=60)
            with wave.open(str(path)) as w:
                frames = w.readframes(w.getnframes())
                rate, width, channels = w.getframerate(), w.getsampwidth(), w.getnchannels()
        audio = np.frombuffer(frames, dtype=np.int16 if width == 2 else np.uint8).astype(np.float32)
        audio = audio / 32768.0 if width == 2 else (audio - 128) / 128.0
        if channels > 1:
            audio = audio.reshape(-1, channels).mean(axis=1)
        yield audio, rate


def load_tts(voice_path: str | Path | None) -> TTS:
    if voice_path and Path(voice_path).exists():
        return PiperTTS(voice_path)
    return WindowsTTS()
