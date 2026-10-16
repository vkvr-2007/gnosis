"""Microphone input and speaker output.

Audio everywhere in Gnosis is 16 kHz, mono, int16, in 80 ms blocks (1280 samples), which is
what the wake word model expects.
"""

from __future__ import annotations

import asyncio
from typing import Iterable

import numpy as np

SAMPLE_RATE = 16_000
BLOCK = 1280  # 80 ms


class Microphone:
    """Streams mic blocks into an asyncio queue from sounddevice's audio thread."""

    def __init__(self, device: int | str | None = None):
        self.device = device
        self._stream = None
        self.queue: asyncio.Queue[np.ndarray] = asyncio.Queue(maxsize=200)

    def start(self) -> None:
        import sounddevice as sd

        loop = asyncio.get_running_loop()

        def push(block: np.ndarray) -> None:
            if self.queue.full():
                self.queue.get_nowait()  # Keep latency low: drop the oldest block, not the newest.
            self.queue.put_nowait(block)

        def callback(indata, frames, time_info, status) -> None:
            loop.call_soon_threadsafe(push, indata[:, 0].copy())

        self._stream = sd.InputStream(samplerate=SAMPLE_RATE, blocksize=BLOCK, channels=1,
                                      dtype="int16", device=self.device, callback=callback)
        self._stream.start()

    def stop(self) -> None:
        if self._stream is not None:
            self._stream.stop()
            self._stream.close()
            self._stream = None

    async def blocks(self):
        while True:
            yield await self.queue.get()

    def drain(self) -> None:
        """Throws away buffered audio, e.g. Gnosis's own voice captured while it was speaking."""
        while not self.queue.empty():
            self.queue.get_nowait()


class Speaker:
    """Plays audio and can be interrupted mid-sentence (barge-in)."""

    def __init__(self, device: int | str | None = None):
        self.device = device
        self._generation = 0  # stop() bumps this; any playback started before then ends
        self._active = 0

    @property
    def speaking(self) -> bool:
        return self._active > 0

    def stop(self) -> None:
        self._generation += 1

    def _play_blocking(self, chunks: Iterable[tuple[np.ndarray, int]], generation: int) -> bool:
        import sounddevice as sd

        stream = None
        try:
            for audio, rate in chunks:
                if self._generation != generation:
                    return False
                if stream is None:
                    stream = sd.OutputStream(samplerate=rate, channels=1, dtype="float32", device=self.device)
                    stream.start()
                audio = np.asarray(audio, dtype=np.float32)
                # Write in small slices so a stop request takes effect within ~50 ms.
                step = max(rate // 20, 1)
                for i in range(0, len(audio), step):
                    if self._generation != generation:
                        return False
                    stream.write(audio[i:i + step])
            return True
        finally:
            if stream is not None:
                stream.stop()
                stream.close()

    async def play(self, chunks: Iterable[tuple[np.ndarray, int]]) -> bool:
        """Plays (audio, sample_rate) chunks. Returns False if it was interrupted."""
        self._active += 1
        try:
            return await asyncio.to_thread(self._play_blocking, chunks, self._generation)
        finally:
            self._active -= 1


def chime(rate: int = 22_050) -> tuple[np.ndarray, int]:
    """A short two-note 'I'm listening' sound."""
    t = np.linspace(0, 0.09, int(rate * 0.09), endpoint=False)
    notes = [np.sin(2 * np.pi * f * t) * np.hanning(len(t)) for f in (880, 1320)]
    return (np.concatenate(notes) * 0.25).astype(np.float32), rate
