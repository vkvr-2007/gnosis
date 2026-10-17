import asyncio
from types import SimpleNamespace

import pytest

from gnosis.brain import Brain
from gnosis.identity import Identity
from gnosis.settings import AppSettings, BrainSettings, Settings


def chunk(text):
    return SimpleNamespace(choices=[SimpleNamespace(delta=SimpleNamespace(content=text))])


class FakeStream:
    def __init__(self, pieces, delay=0.0, fail=None):
        self.pieces, self.delay, self.fail = list(pieces), delay, fail

    def __aiter__(self):
        return self._gen()

    async def _gen(self):
        for p in self.pieces:
            if self.delay:
                await asyncio.sleep(self.delay)
            yield chunk(p)
        if self.fail:
            raise self.fail


class FakeClient:
    """Stands in for openai.AsyncOpenAI: each call answers with the next script entry.

    An entry is a list of text pieces, a dict {pieces, delay, fail}, or an exception to raise at once.
    """

    def __init__(self, *script):
        self.script = list(script)
        self.requests = []
        self.chat = SimpleNamespace(completions=SimpleNamespace(create=self._create))

    async def _create(self, **req):
        self.requests.append(req)
        entry = self.script.pop(0) if self.script else ["OK."]
        if isinstance(entry, Exception):
            raise entry
        if isinstance(entry, dict):
            return FakeStream(entry.get("pieces", []), entry.get("delay", 0.0), entry.get("fail"))
        return FakeStream(entry)


@pytest.fixture
def settings(tmp_path):
    return Settings(brain=BrainSettings(api_key_env="GNOSIS_TEST_KEY"), app=AppSettings(data_dir=str(tmp_path)))


@pytest.fixture
def identity():
    return Identity(name="Gnosis")


def brain_with(settings, *script):
    return Brain(settings.brain, client=FakeClient(*script))
