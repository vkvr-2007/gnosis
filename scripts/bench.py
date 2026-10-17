"""Speed bench: asks five fixed questions in one fresh conversation and times each answer.

  python scripts/bench.py            prints a table and saves it under <data dir>/bench/

"First words" is when the first text arrives, "first sentence" is when speech could start (step 2), and
"done" is the whole answer. Run it before and after any change that touches answering.
"""

from __future__ import annotations

import asyncio
import json
import sys
import tempfile
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from gnosis.conversation import Conversation  # noqa: E402
from gnosis.core import Core  # noqa: E402
from gnosis.identity import load_identity  # noqa: E402
from gnosis.journal import Journal  # noqa: E402
from gnosis.settings import load_settings  # noqa: E402

QUESTIONS = [
    ("chat", "Hi, who are you?"),
    ("time", "What day of the week is it today?"),
    ("explain", "Explain in two sentences what a GPU is."),
    ("list", "Give me three quick tips for a productive morning."),
    ("recall", "What was the first thing I asked you?"),
]


async def bench() -> int:
    settings, identity = load_settings(), load_identity()
    events: list[dict] = []
    with tempfile.TemporaryDirectory() as tmp:
        core = Core(settings, identity, emit=events.append, journal=Journal(None),
                    conversation=Conversation(Path(tmp), settings.conversation.history_messages))
        check = await core.start()
        print(f"Model check: {'OK' if check.ok else 'PROBLEM'} - {check.message} ({check.ms} ms)\n")
        if not check.ok:
            return 1
        rows = []
        for name, q in QUESTIONS:
            ask = await core.ask(q)
            await core.wait()
            end = next(e for e in reversed(events) if e.get("ask") == ask and e["type"] in ("done", "error"))
            if end["type"] == "error":
                rows.append({"name": name, "error": end["message"]})
            else:
                rows.append({"name": name, **end["timings"], "chars": len(end["text"]), "answer": end["text"]})
    print(f"{'question':<10}{'first words':>13}{'first sentence':>16}{'done':>10}{'chars':>7}")
    for r in rows:
        if "error" in r:
            print(f"{r['name']:<10}  ERROR: {r['error']}")
        else:
            print(f"{r['name']:<10}{r['first_text_ms']:>11} ms{r['first_sentence_ms']:>14} ms"
                  f"{r['total_ms']:>8} ms{r['chars']:>7}")
    out = settings.data_dir / "bench" / f"{time.strftime('%Y-%m-%d-%H%M%S')}.json"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps({"model": settings.brain.model, "thinking": settings.brain.thinking,
                               "check_ms": check.ms, "rows": rows}, indent=2), encoding="utf-8")
    print(f"\nSaved to {out}")
    return 0 if all("error" not in r for r in rows) else 1


if __name__ == "__main__":
    sys.exit(asyncio.run(bench()))
