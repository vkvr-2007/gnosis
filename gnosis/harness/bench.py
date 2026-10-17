"""`gnosis bench`: how long standard requests take, against a running `gnosis serve`.

It uses the streaming endpoint, so it reports both the first word (what the owner notices) and the
whole answer. The budgets come from the Gnosis 2 plan; a change that pushes a median over its budget
should not merge.
"""

from __future__ import annotations

import json
import statistics
import time
import uuid

import httpx

# (name, request, budget for the first word, budget for the whole answer), in seconds
QUESTIONS = [
    ("chat", "Say hello in five words.", 1.5, 3.0),
    ("time", "What time is it?", 3.0, 4.0),
    ("memory", "What do you know about my preferences?", 3.0, 4.0),
    ("two tools", "What time is it, and what's my laptop's battery level?", 4.5, 6.0),
]


def _timed(client: httpx.Client, base: str, text: str) -> tuple[float, float]:
    """Seconds to the first streamed word of the answer, and to the whole answer (inf on failure)."""
    started = time.monotonic()
    first, kind = float("inf"), ""
    with client.stream("POST", f"{base}/api/chat/stream",
                       json={"text": text, "session_id": f"bench-{uuid.uuid4().hex[:6]}"}) as r:
        if r.status_code != 200:
            return float("inf"), float("inf")
        for line in r.iter_lines():
            if line.startswith("event: "):
                kind = line[7:]
            elif line.startswith("data: "):
                if kind == "reset":
                    first = float("inf")  # That text led to a tool call; the answer starts later
                elif kind == "delta" and first == float("inf") and json.loads(line[6:]).strip():
                    first = time.monotonic() - started
                elif kind == "done":
                    total = time.monotonic() - started
                    return min(first, total), total
                elif kind == "error":
                    break
    return float("inf"), float("inf")


def main(base: str, rounds: int) -> bool:
    ok = True
    base = base.rstrip("/")
    with httpx.Client(timeout=300) as client:
        print(f"{'request':<10} {'first word':>11} {'answer':>8} {'worst':>8}   budgets")
        for name, text, first_budget, budget in QUESTIONS:
            runs = [_timed(client, base, text) for _ in range(rounds)]
            first = statistics.median(r[0] for r in runs)
            total = statistics.median(r[1] for r in runs)
            within = first <= first_budget and total <= budget
            ok &= within
            print(f"{name:<10} {first:>10.1f}s {total:>7.1f}s {max(r[1] for r in runs):>7.1f}s   "
                  f"{first_budget:.1f}s / {budget:.1f}s  {'ok' if within else 'OVER'}")
    return ok
