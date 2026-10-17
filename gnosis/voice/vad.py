"""Works out when you've finished speaking."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Callable

import numpy as np

from gnosis.voice.audio import BLOCK, SAMPLE_RATE

_SUB = 160  # 10 ms sub-frames for WebRTC VAD
_BLOCK_S = BLOCK / SAMPLE_RATE
_EPS = 1e-6  # Durations are sums of 0.08 s blocks; don't let float rounding add an extra block


def webrtc_detector(aggressiveness: int = 2) -> Callable[[np.ndarray], bool]:
    import webrtcvad

    vad = webrtcvad.Vad(aggressiveness)

    def is_speech(block: np.ndarray) -> bool:
        frames = [block[i:i + _SUB] for i in range(0, len(block) - _SUB + 1, _SUB)]
        voiced = sum(vad.is_speech(f.astype(np.int16).tobytes(), SAMPLE_RATE) for f in frames)
        return voiced * 2 > len(frames)

    return is_speech


class EnergyDetector:
    """Fallback when WebRTC VAD isn't installed: loudness against an adaptive noise floor."""

    def __init__(self, ratio: float = 3.0, min_rms: float = 300.0):
        self.ratio = ratio
        self.min_rms = min_rms
        self.noise = min_rms / ratio

    def __call__(self, block: np.ndarray) -> bool:
        rms = float(np.sqrt(np.mean(block.astype(np.float32) ** 2)))
        speech = rms > max(self.noise * self.ratio, self.min_rms)
        if not speech:
            self.noise = 0.95 * self.noise + 0.05 * rms
        return speech


def default_detector() -> Callable[[np.ndarray], bool]:
    try:
        return webrtc_detector()
    except ImportError:
        return EnergyDetector()


@dataclass
class Endpointer:
    """Collects one utterance: waits for speech to start, then for a pause long enough to end it."""

    is_speech: Callable[[np.ndarray], bool]
    end_silence_s: float = 0.8   # Pause that ends the utterance
    start_timeout_s: float = 5.0  # Give up if nobody says anything
    max_s: float = 15.0          # Longest utterance, counted from when speech started
    min_speech_s: float = 0.25   # Ignore clicks and coughs
    blocks: list[np.ndarray] = field(default_factory=list)
    _speech_s: float = 0.0
    _silence_s: float = 0.0
    _elapsed_s: float = 0.0
    _utterance_s: float = 0.0
    started: bool = False

    def feed(self, block: np.ndarray) -> str | None:
        """Returns None while listening, "done" with a complete utterance, or "timeout"."""
        self._elapsed_s += _BLOCK_S
        speech = self.is_speech(block)
        if not self.started:
            # Keep a little audio from before speech started so the first word isn't clipped.
            self.blocks = (self.blocks + [block])[-8:]
            if speech:
                self._speech_s += _BLOCK_S
                if self._speech_s >= self.min_speech_s - _EPS:
                    self.started = True
            else:
                self._speech_s = 0.0
            return "timeout" if not self.started and self._elapsed_s >= self.start_timeout_s - _EPS else None
        self.blocks.append(block)
        self._utterance_s += _BLOCK_S
        self._silence_s = 0.0 if speech else self._silence_s + _BLOCK_S
        if self._silence_s >= self.end_silence_s - _EPS or self._utterance_s >= self.max_s - _EPS:
            return "done"
        return None

    def audio(self) -> np.ndarray:
        return np.concatenate(self.blocks) if self.blocks else np.zeros(0, dtype=np.int16)
