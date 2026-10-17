"""`gnosis accept`: the laptop acceptance suite, run against a running `gnosis serve`.

These are the checks first done by hand on the owner's laptop, as a script. Each step sends a real
request, then checks the answer and the tools Gnosis used (from the audit log). Any approval a step
asks for is declined, so the suite can never change the owner's files or act for them; approvals that
were already waiting are left alone. Desktop steps open and close real apps, so they only run with
--desktop. Results are also saved as JSON for comparing runs.
"""

from __future__ import annotations

import asyncio
import io
import json
import re
import time
import uuid
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any, Callable

import httpx


@dataclass
class Step:
    name: str
    text: str
    expect_tools: list[str] = field(default_factory=list)     # Each must have been called
    answer_matches: str | None = None                           # Regex the answer must match
    fresh_session: bool = False                                 # No chat history: memory must do it
    files: list[tuple[str, Callable[[], bytes]]] = field(default_factory=list)
    desktop: bool = False
    expect_declined: bool = False  # Passing means Gnosis asked first (and was told no)


@dataclass
class Result:
    name: str
    ok: bool
    seconds: float
    answer: str
    tools: list[str]
    approvals_declined: list[str]
    problems: list[str]


def _notes() -> bytes:
    return b"Shopping list for Sunday:\n- 2 kg basmati rice\n- paneer\n- 6 bananas\nBudget: 1500 rupees\n"


def _shapes_png() -> bytes:
    from PIL import Image, ImageDraw, ImageFont

    img = Image.new("RGB", (480, 240), "white")
    d = ImageDraw.Draw(img)
    d.rectangle([20, 20, 200, 220], fill="red")
    d.ellipse([260, 40, 440, 200], fill="blue")
    try:
        font = ImageFont.truetype("arial.ttf", 36)
    except OSError:
        font = ImageFont.load_default()
    d.text((40, 100), "GNOSIS", fill="white", font=font)
    buf = io.BytesIO()
    img.save(buf, "PNG")
    return buf.getvalue()


STEPS = [
    Step("time", "What time is it?", ["get_time"], r"\d{1,2}[:.]\d{2}"),
    # A new made-up snack each run, so the step proves a real save, not a fact left over from the last run.
    Step("remember", "Remember that my favourite snack is {word}.", ["remember"], r"(?i)saved|noted|remember|{word}"),
    Step("recall in a new conversation", "What is my favourite snack?", [], r"(?i){word}",
         fresh_session=True),
    Step("text attachment", "What's my budget in this note, and how many bananas?", [], r"(?s)1,?500.*6|6.*1,?500",
         files=[("notes.txt", _notes)]),
    Step("image attachment", "What word is written on this picture, and what colour is the circle?",
         ["look_at_image"], r"(?is)gnosis.*blue|blue.*gnosis", files=[("shapes.png", _shapes_png)]),
    Step("open notepad", "Open Notepad.", ["open_app"], None, desktop=True),
    Step("type into a blank page", "Open a new blank tab in Notepad and type hello from Gnosis there.",
         ["type_text"], None, desktop=True),
    Step("open spotify", "Open Spotify.", ["open_app"], None, desktop=True),
    Step("close notepad", "Close Notepad.", ["close_app"], None, desktop=True),
]


class Suite:
    def __init__(self, base: str = "http://127.0.0.1:8765", timeout_s: float = 300):
        self.base = base.rstrip("/")
        self.client = httpx.AsyncClient(timeout=timeout_s)
        self.session = f"accept-{uuid.uuid4().hex[:6]}"
        self.word = "zebra" + uuid.uuid4().hex[:4]

    async def _audit_after(self, last_id: int) -> list[dict[str, Any]]:
        rows = (await self.client.get(f"{self.base}/api/audit")).json()
        return sorted((r for r in rows if r.get("id", 0) > last_id), key=lambda r: r["id"])

    async def _last_audit_id(self) -> int:
        rows = (await self.client.get(f"{self.base}/api/audit")).json()
        return max((r.get("id", 0) for r in rows), default=0)

    async def run_step(self, step: Step) -> Result:
        before_approvals = {a["id"] for a in (await self.client.get(f"{self.base}/api/approvals")).json()}
        last_id = await self._last_audit_id()
        files = []
        for name, make in step.files:
            r = await self.client.post(f"{self.base}/api/files", params={"name": name}, content=make())
            r.raise_for_status()
            files.append(r.json()["id"])
        declined: list[str] = []
        done = asyncio.Event()

        async def decline_new_approvals() -> None:
            while not done.is_set():
                for a in (await self.client.get(f"{self.base}/api/approvals")).json():
                    if a["id"] not in before_approvals:
                        before_approvals.add(a["id"])
                        declined.append(f"{a['tool']}: {a['reason']}")
                        await self.client.post(f"{self.base}/api/approvals/{a['id']}", json={"approved": False})
                await asyncio.sleep(0.3)

        watcher = asyncio.create_task(decline_new_approvals())
        session = f"{self.session}-{uuid.uuid4().hex[:4]}" if step.fresh_session else self.session
        text = step.text.replace("{word}", self.word)
        pattern = (step.answer_matches or "").replace("{word}", self.word)
        started = time.monotonic()
        problems: list[str] = []
        try:
            r = await self.client.post(f"{self.base}/api/chat",
                                       json={"text": text, "session_id": session, "files": files})
            answer = r.json().get("answer") or r.json().get("detail") or r.text
            if r.status_code != 200:
                problems.append(f"HTTP {r.status_code}")
        except httpx.HTTPError as e:
            answer = ""
            problems.append(f"{type(e).__name__}: {e}")
        seconds = time.monotonic() - started
        done.set()
        await watcher
        tools = [row["tool"] for row in await self._audit_after(last_id) if row.get("kind") == "tool_decision"]
        for t in step.expect_tools:
            if t not in tools and not (step.expect_declined and declined):
                problems.append(f"didn't call {t}")
        if pattern and not re.search(pattern, answer or ""):
            problems.append("answer doesn't match")
        if re.search(r"\[#\d+\]|<think>", answer or ""):
            problems.append("answer leaks internal text (a memory id or <think>)")
        if step.expect_declined and not declined:
            problems.append("didn't ask for approval first")
        return Result(step.name, not problems, round(seconds, 1), (answer or "")[:300], tools, declined, problems)

    async def run(self, desktop: bool) -> list[Result]:
        results = []
        for step in STEPS:
            if step.desktop and not desktop:
                continue
            results.append(await self.run_step(step))
            print(_line(results[-1]), flush=True)
        await self.client.aclose()
        return results


def _line(r: Result) -> str:
    head = f"{'PASS' if r.ok else 'FAIL'}  {r.name:<28} {r.seconds:>6.1f} s  tools: {', '.join(r.tools) or '-'}"
    extra = [f"        answer: {r.answer[:160]!r}"]
    extra += [f"        declined: {d}" for d in r.approvals_declined]
    extra += [f"        problem: {p}" for p in r.problems]
    return "\n".join([head] + (extra if (not r.ok or r.approvals_declined) else extra[:1]))


def main(base: str, desktop: bool, report_dir: Path) -> bool:
    results = asyncio.run(Suite(base).run(desktop))
    passed = sum(r.ok for r in results)
    print(f"\n{passed}/{len(results)} passed")
    report_dir.mkdir(parents=True, exist_ok=True)
    path = report_dir / f"accept-{time.strftime('%Y%m%d-%H%M%S')}.json"
    path.write_text(json.dumps([asdict(r) for r in results], indent=2), encoding="utf-8")
    print(f"Report: {path}")
    return passed == len(results)
