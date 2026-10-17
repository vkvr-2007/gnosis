import json

import httpx
import numpy as np

from gnosis.voice import elevenlabs
from gnosis.voice.elevenlabs import ElevenLabsSTT, ElevenLabsTTS, load_stt, wrap_tts


class Local:
    def __init__(self):
        self.heard = []

    def transcribe(self, audio):
        self.heard.append(len(audio))
        return "from the laptop"

    def synthesize(self, text):
        yield np.zeros(10, dtype=np.float32), 22050


def test_scribe_gets_a_wav_and_the_key_in_a_header():
    seen = {}

    def handler(request: httpx.Request):
        seen["url"], seen["key"] = str(request.url), request.headers["xi-api-key"]
        seen["body"] = request.content
        return httpx.Response(200, json={"text": " open spotify "})

    stt = ElevenLabsSTT("k1", client=httpx.Client(transport=httpx.MockTransport(handler)))
    assert stt.transcribe(np.zeros(16000, dtype=np.int16)) == "open spotify"
    assert seen["url"].endswith("/v1/speech-to-text") and seen["key"] == "k1"
    assert b"RIFF" in seen["body"] and b"scribe_v1" in seen["body"]


def test_falls_back_to_the_laptop_when_elevenlabs_fails():
    down = httpx.Client(transport=httpx.MockTransport(lambda r: httpx.Response(401, json={})))
    local = Local()
    stt = ElevenLabsSTT("k", fallback=local, client=down)
    assert stt.transcribe(np.zeros(800, dtype=np.int16)) == "from the laptop" and local.heard == [800]
    tts = ElevenLabsTTS("k", fallback=local, client=down)
    assert [rate for _, rate in tts.synthesize("Hello")] == [22050]


def test_voice_streams_as_16k_pcm_and_skips_links():
    sent = {}
    pcm = (np.arange(5, dtype=np.int16) * 1000).tobytes()

    def handler(request: httpx.Request):
        sent["url"], sent["json"] = str(request.url), json.loads(request.content)
        return httpx.Response(200, content=pcm[:3] + pcm[3:])

    tts = ElevenLabsTTS("k", voice="v9", client=httpx.Client(transport=httpx.MockTransport(handler)))
    chunks = list(tts.synthesize("See **this**: https://example.com"))
    audio = np.concatenate([c for c, _ in chunks])
    assert all(rate == 16000 for _, rate in chunks) and len(audio) == 5 and abs(audio[1] - 1000 / 32768) < 1e-6
    assert "/text-to-speech/v9/stream" in sent["url"] and "output_format=pcm_16000" in sent["url"]
    assert sent["json"]["text"] == "See this: the link"


def test_only_used_when_chosen_and_a_key_is_set(monkeypatch):
    local = Local()
    monkeypatch.delenv(elevenlabs.KEY_ENV, raising=False)
    assert load_stt({"stt": "elevenlabs"}, lambda: local) is local  # No key: stays on the laptop
    monkeypatch.setenv(elevenlabs.KEY_ENV, "k")
    assert load_stt({}, lambda: local) is local
    assert isinstance(load_stt({"stt": "elevenlabs"}, lambda: local), ElevenLabsSTT)
    assert wrap_tts({"tts": "local"}, local) is local
    assert isinstance(wrap_tts({"tts": "elevenlabs"}, local), ElevenLabsTTS)


def test_a_bad_key_is_reported_once_but_missing_permissions_are_not():
    def replying(status, detail):
        return httpx.Client(transport=httpx.MockTransport(lambda r: httpx.Response(status, json={"detail": detail})))

    assert elevenlabs.key_problem(None) == "ELEVENLABS_API_KEY isn't set"
    bad = replying(400, {"code": "invalid_api_key", "message": "API key ID used as API key"})
    assert elevenlabs.key_problem("id_123", client=bad) == "API key ID used as API key"
    no_user_read = replying(401, {"code": "missing_permissions", "message": "needs user_read"})
    assert elevenlabs.key_problem("sk_1", client=no_user_read) is None
    assert elevenlabs.key_problem("sk_1", client=replying(200, {})) is None
