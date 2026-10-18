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
    from gnosis.voice.elevenlabs import api_key, key_problem, load_stt, voice_problem, warm, wrap_tts
    from gnosis.voice.loop import VoiceConfig, VoiceLoop
    from gnosis.voice.stt import SpeechToText
    from gnosis.voice.tts import load_tts
    from gnosis.voice.vad import default_detector
    from gnosis.voice.voice_id import load_voice_id
    from gnosis.voice.wake import load_wake

    cfg = g.settings.voice
    await g.events.publish("voice_state", state="loading")
    if "elevenlabs" in (cfg.get("stt"), cfg.get("tts")):
        # Check the key once, rather than silently falling back on every sentence.
        problem = await asyncio.to_thread(key_problem, api_key())
        if problem:
            g.audit.write("voice", note=f"ElevenLabs is off, using the on-device voice instead: {problem}")
            cfg = {**cfg, "stt": "local", "tts": "local"}
    if cfg.get("tts") == "elevenlabs" and cfg.get("elevenlabs_voice"):
        # A chosen voice that this account can't use would fail every sentence; use the default one instead.
        problem = await asyncio.to_thread(voice_problem, api_key(), cfg["elevenlabs_voice"])
        if problem:
            g.audit.write("voice_error", error=f"ElevenLabs voice {cfg['elevenlabs_voice']} can't be used, "
                                               f"using the default voice instead: {problem}")
            cfg = {**cfg, "elevenlabs_voice": None}
    wake = await asyncio.to_thread(load_wake, cfg)
    stt = await asyncio.to_thread(load_stt, cfg, lambda: SpeechToText(cfg.get("stt_model", "small.en")))
    tts = wrap_tts(cfg, await asyncio.to_thread(load_tts, _expand(cfg.get("piper_voice"))))
    await asyncio.to_thread(warm, stt, tts)
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
    if hasattr(wake, "barge_in"):
        wake.barge_in = bool(cfg.get("barge_in", True))
    g.notifier.speakers.append(loop.say)  # Reminders and other notices are spoken too
    g.voice = loop
    talk_key = cfg.get("talk_key", "ctrl+space")
    if talk_key:
        from gnosis import killswitch

        killswitch.start(loop.push_to_talk, talk_key, name="Talk key")
    mic.start()
    await g.events.publish("voice_state", state="idle", wake_word=wake.label, talk_key=talk_key)
    try:
        await loop.run(mic.blocks())
    finally:
        g.voice = None
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
