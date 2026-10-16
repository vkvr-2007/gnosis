"""Wake word detection with openWakeWord, fully on-device."""

from __future__ import annotations

from pathlib import Path

import numpy as np

# Bundled with openWakeWord; used until a custom "Hey Gnosis" model has been trained.
FALLBACK_MODEL = "hey_jarvis"


class WakeWord:
    def __init__(self, model: str | None = None, threshold: float = 0.5, cooldown_blocks: int = 15):
        """`model` is a path to a custom .onnx model, or the name of a bundled one."""
        from openwakeword import utils
        from openwakeword.model import Model

        name = model or FALLBACK_MODEL
        if Path(name).suffix == ".onnx":
            if not Path(name).exists():
                raise FileNotFoundError(f"Wake word model not found: {name}")
            utils.download_models([])  # Feature models only
        else:
            utils.download_models([name])
        self.model = Model(wakeword_models=[name], inference_framework="onnx")
        self.label = Path(name).stem if Path(name).suffix else name
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
