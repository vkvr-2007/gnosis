import asyncio

import numpy as np
import pytest

from conftest import FakeLLM, reply, tool_call
from gnosis.app import build
from gnosis.core.events import EventBus
from gnosis.voice.audio import BLOCK, SAMPLE_RATE
from gnosis.voice.loop import VoiceConfig, VoiceLoop
from gnosis.voice.tts import speakable
from gnosis.voice.vad import EnergyDetector, Endpointer
from gnosis.voice.voice_id import VoiceID

WAKE = 7777


def tone(freq=220.0, seconds=BLOCK / SAMPLE_RATE, amp=8000):
    t = np.arange(int(seconds * SAMPLE_RATE)) / SAMPLE_RATE
    return (amp * np.sin(2 * np.pi * freq * t)).astype(np.int16)


SILENCE = np.zeros(BLOCK, dtype=np.int16)
SPEECH = tone()
loud = lambda b: int(np.abs(b).max()) > 1000


# ---- end-of-speech detection ---------------------------------------------

def test_endpointer_collects_one_utterance_with_preroll():
    ep = Endpointer(loud)
    assert [ep.feed(SILENCE) for _ in range(2)] == [None, None]
    results = [ep.feed(SPEECH) for _ in range(10)] + [ep.feed(SILENCE) for _ in range(10)]
    assert results[-1] == "done" and results.count("done") == 1
    assert len(ep.audio()) >= 12 * BLOCK  # Speech plus a little audio from just before it


def test_endpointer_ignores_clicks_and_times_out():
    ep = Endpointer(loud, start_timeout_s=1.0)
    out = [ep.feed(SPEECH)] + [ep.feed(SILENCE) for _ in range(12)]
    assert not ep.started and out[-1] == "timeout"


def test_energy_detector_adapts_to_noise():
    d = EnergyDetector()
    noise = (np.random.default_rng(0).normal(0, 80, BLOCK)).astype(np.int16)
    assert not any(d(noise) for _ in range(20))
    assert d(SPEECH)


# ---- voice ID ------------------------------------------------------------

def spectrum_embedder(audio):
    """Stand-in for the real speaker model: voices differ by pitch, so a coarse spectrum separates them."""
    mag = np.abs(np.fft.rfft(audio.astype(np.float32)[: SAMPLE_RATE]))
    bins = np.array_split(mag, 32)
    return np.array([b.mean() for b in bins])


def test_voice_id_enroll_verify_and_persist(tmp_path):
    vid = VoiceID(spectrum_embedder, tmp_path / "vp.npy", threshold=0.8)
    assert vid.verify(tone(300, 2)).is_owner  # Not enrolled: everyone is the owner
    with pytest.raises(ValueError):
        vid.enroll(np.zeros(SAMPLE_RATE * 30, dtype=np.int16))
    assert vid.enroll(tone(200, 30)) == 10
    assert vid.verify(tone(200, 2)).is_owner
    assert not vid.verify(tone(2000, 2)).is_owner
    assert not vid.verify(tone(200, 0.2)).is_owner  # Too short to judge
    again = VoiceID(spectrum_embedder, tmp_path / "vp.npy", threshold=0.8)
    assert again.enrolled and again.verify(tone(200, 2)).is_owner


# ---- voice loop ----------------------------------------------------------

class FakeWake:
    label = "test"

    def heard(self, block):
        return int(block[0]) == WAKE


class FakeSTT:
    def __init__(self, *texts):
        self.texts = list(texts)

    def transcribe(self, audio):
        return self.texts.pop(0)


class FakeTTS:
    def synthesize(self, text):
        yield np.zeros(10, dtype=np.float32), 22050


class FakeSpeaker:
    def __init__(self):
        self.played, self.stops, self.speaking = [], 0, False

    def stop(self):
        self.stops += 1

    async def play(self, chunks):
        self.played.append(list(chunks))
        return True


class FakeOrchestrator:
    def __init__(self):
        self.calls = []

    async def handle(self, text, session_id="default", tags=None, owner=True):
        self.calls.append((text, owner))
        return f"You said {text}"


class FakeVoiceID:
    def __init__(self, owner):
        self.owner = owner

    def verify(self, audio):
        return type("V", (), {"is_owner": self.owner, "score": 0.9 if self.owner else 0.1})()


def wake_block():
    b = SILENCE.copy()
    b[0] = WAKE
    return b


def make_loop(*texts, voice_id=None):
    speaker, orch = FakeSpeaker(), FakeOrchestrator()
    loop = VoiceLoop(wake=FakeWake(), stt=FakeSTT(*texts), tts=FakeTTS(), speaker=speaker,
                     orchestrator=orch, events=EventBus(), detector=loud, voice_id=voice_id,
                     config=VoiceConfig(follow_up_s=1.0))
    return loop, speaker, orch


async def say(loop, wake=True):
    blocks = ([wake_block()] if wake else []) + [SPEECH] * 6 + [SILENCE] * 11
    for b in blocks:
        await loop.feed(b)
    await loop.drain()


def test_wake_listen_answer_then_follow_up_without_wake_word():
    loop, speaker, orch = make_loop("open spotify", "play madhuvarame")

    async def go():
        await say(loop)
        assert orch.calls == [("open spotify", True)]
        assert loop.state == "listening"  # Follow-up window
        await say(loop, wake=False)
        assert orch.calls[-1] == ("play madhuvarame", True)

    asyncio.run(go())
    assert len(speaker.played) == 3  # Chime, first answer, follow-up answer (no chime without wake word)


def test_speech_without_wake_word_is_ignored():
    loop, _, orch = make_loop("hello")
    asyncio.run(say(loop, wake=False))
    assert orch.calls == []


def test_unrecognised_voice_runs_in_guest_mode():
    loop, _, orch = make_loop("send an email", voice_id=FakeVoiceID(owner=False))
    asyncio.run(say(loop))
    assert orch.calls == [("send an email", False)]


def test_stop_word_and_barge_in():
    loop, speaker, orch = make_loop("stop")

    async def go():
        speaker.speaking = True
        await loop.feed(wake_block())  # Wake word while talking interrupts it
        assert speaker.stops == 1
        speaker.speaking = False
        for b in [SPEECH] * 6 + [SILENCE] * 11:
            await loop.feed(b)
        await loop.drain()

    asyncio.run(go())
    assert orch.calls == [] and loop.state == "idle"


def test_long_task_continues_in_background_and_announces_when_done():
    loop, speaker, orch = make_loop("build the website")
    loop.config.background_after_s = 0.05
    said, release = [], asyncio.Event()
    loop.tts = type("T", (), {"synthesize": lambda self, text: said.append(text) or iter([])})()

    async def slow(text, session_id="default", tags=None, owner=True):
        await release.wait()
        return "The website is live."

    orch.handle = slow

    async def go():
        blocks = [wake_block()] + [SPEECH] * 6 + [SILENCE] * 11
        for b in blocks:
            await loop.feed(b)
        while not said:
            await asyncio.sleep(0.01)
        assert said == ["I'm on it. I'll tell you when it's done."]
        loop._endpointer = None  # The owner didn't follow up
        release.set()
        await loop.drain()

    asyncio.run(go())
    assert said[-1] == "The website is live."


def test_speakable_strips_markdown():
    assert speakable("**Done!** See [the site](https://x.y) or https://z.com\n```py\nx=1\n```") == \
        "Done! See the site or the link (code shown on screen)"


# ---- guest mode in the agent ---------------------------------------------

def test_guest_mode_blocks_owner_tools_and_memory(settings):
    llm = FakeLLM([reply(calls=[tool_call("remember", {"subject": "owner", "predicate": "x", "value": "y"})]),
                   reply("Sorry, I can't do that for you.")])
    g = build(settings, llm=llm)
    g.memory.remember("owner", "name", "Vaarsh")
    g.memory.store.update_fact(1, pinned=True)

    async def go():
        answer = await g.orchestrator.handle("remember something", owner=False)
        await g.memory.drain()
        return answer

    assert asyncio.run(go()) == "Sorry, I can't do that for you."
    first = llm.calls[0]["messages"]
    assert not any("Vaarsh" in m["content"] for m in first)  # The guest never sees owner memory
    assert "only the owner" in llm.calls[1]["messages"][-1]["content"]
    assert g.memory.store.episodes() == []  # Guests don't create memories
    assert g.policy.decide("get_time", owner=False).action == "allow"


def test_never_silent_after_the_wake_word():
    async def go():
        # Woken, but nobody speaks
        loop, speaker, orch = make_loop()
        await loop.feed(wake_block())
        for _ in range(80):
            await loop.feed(SILENCE)
        await loop.drain()
        assert len(speaker.played) == 2 and orch.calls == [] and loop.state == "idle"  # Chime, "didn't hear"

        # Heard something, but speech recognition got no words
        loop, speaker, orch = make_loop("")
        await say(loop)
        assert len(speaker.played) == 2 and orch.calls == []

        # Speech recognition crashes
        loop, speaker, orch = make_loop()
        errors = loop.events.subscribe()
        await say(loop)  # FakeSTT has no texts left, so it raises
        assert len(speaker.played) == 2
        seen = []
        while not errors.empty():
            seen.append(await errors.get())
        assert any(e["type"] == "voice_error" and "IndexError" in e["error"] for e in seen)

    asyncio.run(go())


def test_memory_fact_ids_are_not_read_aloud():
    assert speakable("You prefer TypeScript. [#1]") == "You prefer TypeScript."


# ---- "Hey Gnosis" ----------------------------------------------------------

def test_wake_phrase_matches_how_whisper_hears_gnosis():
    from gnosis.voice.wake import match_wake_phrase

    for heard in ("Hey Gnosis.", "hey nosis", "Hey, Noses!", "Hi Gnosis", "Okay, knows is"):
        assert match_wake_phrase(heard) == "", heard
    assert match_wake_phrase("Hey Gnosis, what time is it?") == "what time is it?"
    for other in ("hey there", "I read about gnosis", "Gnosis is a word", "hey nose"):
        assert match_wake_phrase(other) is None, other


def phrase_wake(*texts):
    from gnosis.voice.wake import PhraseWake

    heard = list(texts)
    return PhraseWake(transcribe=lambda audio: heard.pop(0), detector=loud)


def feed_utterance(wake, seconds_of_speech=0.8):
    hits = [wake.heard(b) for b in [SPEECH] * int(seconds_of_speech / 0.08) + [SILENCE] * 8]
    wake._pool.shutdown(wait=True)  # Let the background transcription finish
    return any(hits) or wake.heard(SILENCE)


def test_phrase_wake_hears_the_phrase_and_keeps_a_same_breath_command():
    wake = phrase_wake("Hey Gnosis, open Spotify.")
    assert feed_utterance(wake)
    assert wake.take_command() == "open Spotify." and wake.take_command() == ""
    assert wake.last_audio is not None and len(wake.last_audio) > 0
    assert not feed_utterance(phrase_wake("what's the weather"))


def test_phrase_wake_waits_any_time_before_the_phrase():
    wake = phrase_wake("hey gnosis")
    for _ in range(400):  # 32 s of silence first must not cut the utterance short
        assert not wake.heard(SILENCE)
    assert feed_utterance(wake, seconds_of_speech=1.2)


class CommandWake(FakeWake):
    """Like PhraseWake after "Hey Gnosis, open spotify" in one breath."""
    needs_quiet = True

    def __init__(self):
        self.command, self.last_audio = "", SPEECH

    def heard(self, block):
        if int(block[0]) == WAKE:
            self.command = "open spotify"
            return True
        return False

    def take_command(self):
        command, self.command = self.command, ""
        return command


def test_a_same_breath_command_is_answered_without_a_second_listen_and_still_voice_checked():
    speaker, orch = FakeSpeaker(), FakeOrchestrator()
    loop = VoiceLoop(wake=CommandWake(), stt=FakeSTT(), tts=FakeTTS(), speaker=speaker, orchestrator=orch,
                     events=EventBus(), detector=loud, voice_id=FakeVoiceID(owner=False),
                     config=VoiceConfig(follow_up_s=0))

    async def go():
        await loop.feed(wake_block())
        await loop.drain()

    asyncio.run(go())
    assert orch.calls == [("open spotify", False)]  # Guest: voice ID still ran on the wake audio
