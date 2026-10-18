"""Step 2: talk key, interrupting by voice with an echo filter, "On it", sentences prepared ahead,
end of speech from silence plus words, and the face's states."""

import asyncio
import threading
from concurrent.futures import Future

import numpy as np
from fastapi.testclient import TestClient

from conftest import FakeLLM, reply, tool_call
from gnosis.app import build
from gnosis.core.events import EventBus
from gnosis.killswitch import parse_hotkey
from gnosis.server.api import create_app
from gnosis.voice.loop import VoiceConfig, VoiceLoop, _Sentences
from gnosis.voice.vad import Endpointer, sounds_finished
from gnosis.voice.wake import PhraseWake, is_echo, match_interrupt
from test_voice import (SILENCE, SPEECH, FakeOrchestrator, FakeSpeaker, FakeSTT, FakeTTS, FakeWake, loud,
                        say)


def done(value):
    f = Future()
    f.set_result(value)
    return f


# ---- end of speech: silence plus words -------------------------------------------

def test_sounds_finished():
    for text in ["What time is it?", "Open Notepad please", "Play Madhuvarame on Spotify"]:
        assert sounds_finished(text), text
    for text in ["Open Spotify and", "Remind me to", "Play some,", "um", "", "So I was thinking..."]:
        assert not sounds_finished(text), text


def ends_after(check, speech_blocks=6):
    """Seconds of silence after which the endpointer ends the utterance."""
    ep = Endpointer(loud, check=check)
    for b in [SPEECH] * speech_blocks:
        assert ep.feed(b) is None
    for n in range(1, 40):
        if ep.feed(SILENCE) == "done":
            return round(n * 0.08, 2)


def test_a_finished_sentence_ends_quickly_and_a_trailing_one_waits():
    assert ends_after(lambda audio: done(True)) == 0.4
    assert ends_after(lambda audio: done(False)) == 1.44
    assert ends_after(lambda audio: Future()) == 0.8  # Check still running: the normal pause
    assert ends_after(None) == 0.8


def test_speech_after_a_pause_throws_away_the_old_check():
    checks = []
    ep = Endpointer(loud, check=lambda audio: checks.append(len(audio)) or done(False))
    for b in [SPEECH] * 6 + [SILENCE] * 6 + [SPEECH] * 3 + [SILENCE] * 5:
        assert ep.feed(b) is None
    assert ep.feed(SILENCE) is None and len(checks) == 2 and checks[1] > checks[0]


# ---- interrupting: "stop", "wait", a new request, and the echo filter ---------------

def test_interrupt_words():
    assert match_interrupt("Stop.") == "stop" and match_interrupt("stop it please") == "stop"
    assert match_interrupt("Wait!") == "wait" and match_interrupt("hold on") == "wait"
    assert match_interrupt("one second") == "wait"
    assert match_interrupt("stop the music and play jazz") is None


def test_echo_is_gnosis_hearing_itself():
    said = "It's 9 PM in Delhi. The sun set at 5:45 PM."
    assert is_echo("the sun set at five forty five", said) or is_echo("the sun set at 5 45", said)
    assert is_echo("its 9 pm in delhi", said)
    assert not is_echo("open spotify and play jazz", said)
    assert not is_echo("anything", "")


def caught(text, speaking=True, said="It's 9 PM. Hey Gnosis is my name. Stop by any time.", barge_in=True):
    wake = PhraseWake(transcribe=lambda audio: text, detector=loud)
    wake.barge_in = barge_in
    wake.speaking, wake.spoken_text = (lambda: speaking), (lambda: said)
    return (wake.kind, wake.command) if wake._caught(text) else None


def test_what_is_heard_while_gnosis_talks():
    assert caught("stop") == ("stop", "")             # Always heard, even though Gnosis said "Stop by"
    assert caught("wait") == ("wait", "")
    assert caught("open spotify and play jazz") == ("barge", "open spotify and play jazz")
    assert caught("hey gnosis is my name") is None    # Its own voice saying the wake phrase
    assert caught("hey gnosis what's the weather") == ("wake", "what's the weather")
    assert caught("ok") is None                       # Too short to be a new request
    assert caught("stop", speaking=False) is None      # Not talking: only the wake phrase counts
    assert caught("open spotify and play jazz", speaking=False) is None
    # Off by default: other people talking nearby mustn't cut Gnosis off. "stop" still works.
    assert caught("open spotify and play jazz", barge_in=False) is None
    assert caught("stop", barge_in=False) == ("stop", "")
    assert PhraseWake(transcribe=lambda a: "", detector=loud).barge_in is False


class ScriptedWake(FakeWake):
    """Catches whatever `next` is set to on the next block."""
    needs_quiet = True

    def __init__(self):
        self.next, self.kind, self.command = None, "wake", ""

    def heard(self, block):
        if self.next is None:
            return False
        (self.kind, self.command), self.next = self.next, None
        return True

    def take_command(self):
        command, self.command = self.command, ""
        return command


def make(*texts, **kw):
    speaker, orch, wake = FakeSpeaker(), FakeOrchestrator(), ScriptedWake()
    loop = VoiceLoop(wake=wake, stt=FakeSTT(*texts), tts=FakeTTS(), speaker=speaker, orchestrator=orch,
                     events=EventBus(), detector=loud, config=VoiceConfig(follow_up_s=0, **kw))
    return loop, speaker, orch, wake


def test_stop_while_talking_just_stops_talking():
    loop, speaker, orch, wake = make()

    async def go():
        speaker.speaking, wake.next = True, ("stop", "")
        await loop.feed(SILENCE)
        await loop.drain()

    asyncio.run(go())
    assert speaker.stops == 1 and orch.calls == [] and loop.state == "idle"


def test_wait_while_talking_stops_and_listens():
    loop, speaker, orch, wake = make("actually open notepad")

    async def go():
        speaker.speaking, wake.next = True, ("wait", "")
        await loop.feed(SILENCE)
        assert speaker.stops == 1 and loop.state == "listening"
        speaker.speaking = False
        for b in [SPEECH] * 6 + [SILENCE] * 11:
            await loop.feed(b)
        await loop.drain()

    asyncio.run(go())
    assert orch.calls == [("actually open notepad", True)]


def test_a_new_request_said_over_gnosis_interrupts_and_is_answered():
    loop, speaker, orch, wake = make()

    async def go():
        speaker.speaking, wake.next = True, ("barge", "what's the weather")
        await loop.feed(SILENCE)
        await loop.drain()

    asyncio.run(go())
    assert speaker.stops == 1 and orch.calls == [("what's the weather", True)]


def test_talk_key_listens_and_interrupts():
    loop, speaker, orch, wake = make("open spotify")

    async def go():
        speaker.speaking = True
        await loop.push_to_talk()
        assert speaker.stops == 1 and loop.state == "listening"
        speaker.speaking = False
        await loop.push_to_talk()  # Pressed again while listening: keeps the same listen
        for b in [SPEECH] * 6 + [SILENCE] * 11:
            await loop.feed(b)
        await loop.drain()

    asyncio.run(go())
    assert orch.calls == [("open spotify", True)]


def test_talk_key_parses():
    mods, vk = parse_hotkey("ctrl+space")
    assert vk == 0x20 and mods & 0x0002


# ---- "On it" and the working face --------------------------------------------------

def tool_orchestrator(orch, tool):
    async def handle(text, session_id="default", tags=None, owner=True, on_text=None, on_tool=None):
        orch.calls.append((text, owner))
        await on_tool(tool)
        await asyncio.sleep(0.05)
        await on_text("Spotify is playing.")
        return "Spotify is playing."
    orch.handle = handle


def recording_tts(said):
    return type("T", (), {"synthesize": lambda self, text: said.append(text) or iter([(np.zeros(4), 16000)])})()


def test_on_it_is_said_when_a_slow_tool_starts():
    loop, speaker, orch, wake = make("play jazz on spotify")
    said, states = [], []
    loop.tts = recording_tts(said)
    tool_orchestrator(orch, "play_music")
    q = loop.events.subscribe()
    asyncio.run(say_without_wake(loop))
    while not q.empty():
        states.append(q.get_nowait().get("state"))
    assert said == ["On it.", "Spotify is playing."]
    assert "working" in states and states.index("working") < states.index("speaking")


def test_no_on_it_for_a_quick_tool():
    loop, speaker, orch, wake = make("what time is it")
    said = []
    loop.tts = recording_tts(said)
    tool_orchestrator(orch, "get_time")
    asyncio.run(say_without_wake(loop))
    assert said == ["Spotify is playing."]


async def say_without_wake(loop):
    await loop.push_to_talk()
    for b in [SPEECH] * 6 + [SILENCE] * 11:
        await loop.feed(b)
    await loop.drain()


# ---- the next sentence is prepared while this one plays ----------------------------

def test_the_next_sentence_is_prepared_while_the_first_plays():
    second_started = threading.Event()

    class SlowTTS:
        def synthesize(self, text):
            if text.startswith("Second"):
                second_started.set()
            yield np.zeros(4, dtype=np.float32), 16000

    s = _Sentences()
    s.feed("First sentence. Second sentence. ")
    s.finish()
    chunks = s.chunks(SlowTTS())
    next(chunks)  # The first sentence is playing...
    assert second_started.wait(2)  # ...and the second is already being made
    assert len(list(chunks)) == 1


def test_interrupting_stops_preparing_more_speech():
    made = []

    class TTS:
        def synthesize(self, text):
            made.append(text)
            yield np.zeros(4, dtype=np.float32), 16000

    s = _Sentences()
    chunks = s.chunks(TTS())
    s.feed("One. ")
    next(chunks)
    s.cancel()
    s.feed("Two. Three. ")
    assert list(chunks) == [] and made == ["One."]


# ---- wiring -------------------------------------------------------------------------

def test_orchestrator_reports_each_tool_as_it_starts(settings):
    g = build(settings, llm=FakeLLM([reply(calls=[tool_call("get_time", {})]), reply("It's Friday.")]))
    started = []

    async def on_tool(name):
        started.append(name)

    assert asyncio.run(g.orchestrator.handle("what day is it", on_tool=on_tool)) == "It's Friday."
    assert started == ["get_time"]


def test_talk_api_needs_the_voice(settings):
    g = build(settings, llm=FakeLLM([]))
    client = TestClient(create_app(g))
    assert client.post("/api/voice/talk").status_code == 409

    class Voice:
        pressed = 0

        async def push_to_talk(self):
            Voice.pressed += 1

    g.voice = Voice()
    assert client.post("/api/voice/talk").json() == {"ok": True} and Voice.pressed == 1


def test_the_page_can_show_the_current_voice_state(settings):
    g = build(settings, llm=FakeLLM([]))
    client = TestClient(create_app(g))
    assert client.get("/api/health").json()["voice"] is None
    asyncio.run(g.events.publish("voice_state", state="listening"))
    assert client.get("/api/health").json()["voice"]["state"] == "listening"
    page = client.get("/").text
    for state in ("sleeping", "listening", "thinking", "working", "speaking"):
        assert f".face.{state}" in page, state


def test_an_answer_still_being_written_is_waited_for_not_an_error():
    # Seen on the laptop: every streamed voice answer failed with "InvalidStateError: Result is not set",
    # because the whole answer was read as soon as the first sentence was ready.
    loop, speaker, orch, wake = make("what time is it")
    said, errors = [], []
    loop.tts = recording_tts(said)
    loop.on_error = errors.append

    async def handle(text, session_id="default", tags=None, owner=True, on_text=None, on_tool=None):
        await on_text("It's 9 PM. ")
        await asyncio.sleep(0.1)  # Still writing the rest
        await on_text("Sleep well.")
        return "It's 9 PM. Sleep well."

    orch.handle = handle
    asyncio.run(say_without_wake(loop))
    assert errors == [] and said == ["It's 9 PM.", "Sleep well."]
