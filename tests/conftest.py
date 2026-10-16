import json
from pathlib import Path
from types import SimpleNamespace

import pytest
import yaml

from gnosis.config import REPO_ROOT, Settings
from gnosis.core.model_router import Route


def tool_call(name, args, call_id="c1"):
    return SimpleNamespace(id=call_id, function=SimpleNamespace(name=name, arguments=json.dumps(args)))


def reply(content=None, calls=None):
    return SimpleNamespace(content=content, tool_calls=calls or None)


class FakeLLM:
    """Plays back a scripted list of model messages and records what it was asked."""

    online = True

    def __init__(self, script, facts=None, embeddings=None):
        self.script = list(script)
        self.facts = facts or []          # What fact extraction returns
        self.embeddings = embeddings      # text -> vector, or None for "no embedder running"
        self.calls = []

    async def embed(self, texts):
        if self.embeddings is None:
            return None
        return [self.embeddings(t) for t in texts]

    async def chat(self, role, messages, tools=None, tags=(), **kw):
        call = {"role": role, "messages": [dict(m) for m in messages], "tags": set(tags)}
        if "long-term memory" in messages[0]["content"]:
            self.extraction_calls = getattr(self, "extraction_calls", []) + [call]
            msg = reply(json.dumps({"facts": self.facts}))
        else:
            self.calls.append(call)
            msg = self.script.pop(0)
        route = Route(role, "fake", "fake-model", "", None, False, "default")
        return SimpleNamespace(message=msg, route=route, redactions=0, latency_ms=1)


@pytest.fixture
def settings(tmp_path: Path) -> Settings:
    load = lambda p: yaml.safe_load((REPO_ROOT / p).read_text())
    return Settings(data_dir=tmp_path, models=load("config/models.yaml"),
                    policy=load("config/policy.yaml"), approval_timeout_s=2)
