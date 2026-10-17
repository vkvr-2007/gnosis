"""Voice for Gnosis: wake word, speech recognition, spoken replies and voice ID.

All on-device by default. Speech recognition and spoken replies can use ElevenLabs instead (see elevenlabs.py).
"""

from __future__ import annotations

import asyncio
from pathlib import Path
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from gnosis.app import Gnosis

ENROLL_SCRIPT = (
    "Hey Gnosis, this is my voice. I'm teaching you to recognise me so that only I can send messages, "
    "make calls and change things on my laptop. You can still play music for my friends, but anything "
    "personal should wait for me. Today I want to build a website, check my reminders, open my apps, "
    "and call my family later this evening. Thanks for helping me get things done."
)


def _expand(p: str | None) -> Path | None:
    return Path(p).expanduser() if p else None


async def run_voice(g: "Gnosis") -> None:
    """Runs the voice loop until cancelled. Heavy models load in a thread so the server stays responsive."""
    from gnosis.voice.audio import Microphone, Speaker
    from gnosis.voice.elevenlabs import load_stt, wrap_tts
    from gnosis.voice.loop import VoiceConfig, VoiceLoop
    from gnosis.voice.stt import SpeechToText
    from gnosis.voice.tts import load_tts
    from gnosis.voice.vad import default_detector
    from gnosis.voice.voice_id import load_voice_id
    from gnosis.voice.wake import WakeWord

    cfg = g.settings.voice
    await g.events.publish("voice_state", state="loading")
    wake = await asyncio.to_thread(WakeWord, cfg.get("wake_model"), float(cfg.get("wake_threshold", 0.5)))
    stt = await asyncio.to_thread(load_stt, cfg, lambda: SpeechToText(cfg.get("stt_model", "small.en")))
    tts = wrap_tts(cfg, await asyncio.to_thread(load_tts, _expand(cfg.get("piper_voice"))))
    voice_id = None
    if cfg.get("voice_id", True):
        voice_id = await asyncio.to_thread(load_voice_id, g.settings.data_dir,
                                           float(cfg.get("voice_id_threshold", 0.30)))
        if voice_id is None:
            g.audit.write("voice", note="voice ID libraries not installed; every voice is treated as the owner")
        elif not voice_id.enrolled:
            g.audit.write("voice", note="voice ID not enrolled yet; run `python -m gnosis enroll`")

    mic = Microphone(cfg.get("input_device"))
    speaker = Speaker(cfg.get("output_device"))
    g.on_stop.append(speaker.stop)
    loop = VoiceLoop(wake=wake, stt=stt, tts=tts, speaker=speaker, orchestrator=g.orchestrator,
                     events=g.events, detector=default_detector(), voice_id=voice_id,
                     config=VoiceConfig(follow_up_s=float(cfg.get("follow_up_s", 4))),
                     on_audio_drain=mic.drain, on_stop_command=g.stop_all,
                     on_error=lambda e: g.audit.write("voice_error", error=e))
    g.notifier.speakers.append(loop.say)  # Reminders and other notices are spoken too
    mic.start()
    await g.events.publish("voice_state", state="idle", wake_word=wake.label)
    try:
        await loop.run(mic.blocks())
    finally:
        g.notifier.speakers.remove(loop.say)
        mic.stop()


def enroll(g: "Gnosis", seconds: float = 30.0) -> int:
    """Records the owner reading a short script and saves their voice print."""
    import numpy as np
    import sounddevice as sd

    from gnosis.voice.audio import SAMPLE_RATE
    from gnosis.voice.voice_id import load_voice_id

    voice_id = load_voice_id(g.settings.data_dir, float(g.settings.voice.get("voice_id_threshold", 0.30)))
    if voice_id is None:
        raise SystemExit('Voice ID needs extra packages: pip install -e ".[voiceid]"')
    print("Read this aloud in your normal voice when recording starts:\n")
    print("  " + ENROLL_SCRIPT + "\n")
    input("Press Enter to start recording...")
    audio = sd.rec(int(seconds * SAMPLE_RATE), samplerate=SAMPLE_RATE, channels=1, dtype="int16")
    print(f"Recording for {int(seconds)} seconds...")
    sd.wait()
    return voice_id.enroll(np.asarray(audio)[:, 0])
