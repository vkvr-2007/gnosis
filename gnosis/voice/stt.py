"""Speech to text with faster-whisper on the CPU. Audio never leaves the laptop."""

from __future__ import annotations

import numpy as np


class SpeechToText:
    def __init__(self, model: str = "small.en", compute_type: str = "int8", cpu_threads: int = 0):
        from faster_whisper import WhisperModel

        self.model = WhisperModel(model, device="cpu", compute_type=compute_type, cpu_threads=cpu_threads)

    def transcribe(self, audio: np.ndarray) -> str:
        """`audio` is 16 kHz mono int16 or float32."""
        if audio.dtype == np.int16:
            audio = audio.astype(np.float32) / 32768.0
        segments, _ = self.model.transcribe(audio, language="en", beam_size=1,
                                            condition_on_previous_text=False, vad_filter=False)
        return " ".join(s.text.strip() for s in segments).strip()
