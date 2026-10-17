"""Smoke test: the model check plus one real question, end to end through the core. Exit code 0 = working.

  python scripts/smoke.py
"""

from __future__ import annotations

import asyncio
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from gnosis.conversation import Conversation  # noqa: E402
from gnosis.core import Core  # noqa: E402
from gnosis.identity import load_identity  # noqa: E402
from gnosis.journal import Journal  # noqa: E402
from gnosis.settings import load_settings  # noqa: E402


async def smoke() -> int:
    settings, identity = load_settings(), load_identity()
    events: list[dict] = []
    with tempfile.TemporaryDirectory() as tmp:
        core = Core(settings, identity, emit=events.append, journal=Journal(None),
                    conversation=Conversation(Path(tmp)))
        check = await core.start()
        if not check.ok:
            print(f"FAIL model check: {check.message}")
            return 1
        ask = await core.ask("In one short sentence, what is your name?")
        await core.wait()
    texts = [e for e in events if e.get("ask") == ask and e["type"] == "text"]
    end = next((e for e in events if e.get("ask") == ask and e["type"] in ("done", "error")), None)
    if not end or end["type"] == "error":
        print(f"FAIL answer: {end['message'] if end else 'no answer'}")
        return 1
    print(f"OK ({len(texts)} streamed pieces, {end['timings']['total_ms']} ms): {end['text']}")
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(smoke()))
