"""`gnosis bench`: how long standard requests take, against a running `gnosis serve`.

The budgets come from the Gnosis 2 plan; a change that pushes a median over its budget should not
merge. Answers aren't streamed yet, so this times the full answer.
"""

from __future__ import annotations

import statistics
import time
import uuid

import httpx

# (name, request, budget in seconds for the full answer)
QUESTIONS = [
    ("chat", "Say hello in five words.", 3.0),
    ("time", "What time is it?", 4.0),
    ("memory", "What do you know about my preferences?", 4.0),
    ("two tools", "What time is it, and what's my laptop's battery level?", 6.0),
]


def main(base: str, rounds: int) -> bool:
    ok = True
    with httpx.Client(timeout=300) as client:
        print(f"{'request':<10} {'median':>8} {'worst':>8} {'budget':>8}")
        for name, text, budget in QUESTIONS:
            times = []
            for _ in range(rounds):
                started = time.monotonic()
                r = client.post(f"{base.rstrip('/')}/api/chat",
                                json={"text": text, "session_id": f"bench-{uuid.uuid4().hex[:6]}"})
                times.append(time.monotonic() - started if r.status_code == 200 else float("inf"))
            median = statistics.median(times)
            within = median <= budget
            ok &= within
            print(f"{name:<10} {median:>7.1f}s {max(times):>7.1f}s {budget:>7.1f}s  {'ok' if within else 'OVER'}")
    return ok
