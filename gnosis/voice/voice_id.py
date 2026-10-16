"""Voice ID: recognises the owner's voice so only they can give owner-level commands.

The voice print is a speaker embedding (SpeechBrain ECAPA-TDNN), computed and stored on the laptop.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Protocol

import numpy as np

from gnosis.voice.audio import SAMPLE_RATE

CHUNK_S = 3.0


class Embedder(Protocol):
    def __call__(self, audio: np.ndarray) -> np.ndarray: ...


def ecapa_embedder(cache_dir: Path) -> Embedder:
    import torch
    from speechbrain.inference.speaker import EncoderClassifier

    model = EncoderClassifier.from_hparams(source="speechbrain/spkrec-ecapa-voxceleb",
                                           savedir=str(cache_dir / "ecapa"),
                                           run_opts={"device": "cpu"})

    def embed(audio: np.ndarray) -> np.ndarray:
        wav = torch.from_numpy(_float(audio)).unsqueeze(0)
        with torch.no_grad():
            return model.encode_batch(wav).squeeze().numpy()

    return embed


def _float(audio: np.ndarray) -> np.ndarray:
    return audio.astype(np.float32) / 32768.0 if audio.dtype == np.int16 else audio.astype(np.float32)


def _unit(v: np.ndarray) -> np.ndarray:
    n = float(np.linalg.norm(v))
    return v / n if n else v


@dataclass
class Verdict:
    is_owner: bool
    score: float


class VoiceID:
    def __init__(self, embedder: Embedder, print_path: Path, threshold: float = 0.30):
        self.embedder = embedder
        self.print_path = print_path
        self.threshold = threshold
        self.voiceprint: np.ndarray | None = np.load(print_path) if print_path.exists() else None

    @property
    def enrolled(self) -> bool:
        return self.voiceprint is not None

    def enroll(self, audio: np.ndarray) -> int:
        """Builds the voice print from ~30 s of the owner speaking. Returns how many chunks were used."""
        size = int(CHUNK_S * SAMPLE_RATE)
        chunks = [audio[i:i + size] for i in range(0, len(audio) - size + 1, size)]
        chunks = [c for c in chunks if float(np.sqrt(np.mean(_float(c) ** 2))) > 0.01]  # Skip silence
        if len(chunks) < 3:
            raise ValueError("Need at least 10 seconds of clear speech to enroll")
        prints = np.stack([_unit(self.embedder(c)) for c in chunks])
        self.voiceprint = _unit(prints.mean(axis=0))
        self.print_path.parent.mkdir(parents=True, exist_ok=True)
        np.save(self.print_path, self.voiceprint)
        return len(chunks)

    def verify(self, audio: np.ndarray) -> Verdict:
        if self.voiceprint is None:
            return Verdict(True, 1.0)  # Not enrolled yet: everyone is treated as the owner.
        if len(audio) < SAMPLE_RATE // 2:
            return Verdict(False, 0.0)  # Too short to tell
        score = float(np.dot(_unit(self.embedder(audio)), self.voiceprint))
        return Verdict(score >= self.threshold, score)


def load_voice_id(data_dir: Path, threshold: float = 0.30,
                  embedder_factory: Callable[[Path], Embedder] = ecapa_embedder) -> VoiceID | None:
    """Returns None when the voice ID libraries aren't installed."""
    try:
        embedder = embedder_factory(data_dir / "models")
    except ImportError:
        return None
    return VoiceID(embedder, data_dir / "voiceprint.npy", threshold)
