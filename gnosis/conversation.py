"""The conversation: kept on disk so it survives closing the window and restarting Gnosis."""

from __future__ import annotations

import json
from datetime import datetime
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo


def now_stamp(tz: str = "", now: datetime | None = None) -> str:
    """The local time stamp put on each question (not in the system prompt, so the prompt stays cacheable)."""
    zone = ZoneInfo(tz) if tz else None
    t = (now or datetime.now(zone)).astimezone(zone)
    return f"[Now: {t.strftime('%A')} {t.day} {t.strftime('%B %Y, %H:%M')} {t.tzname() or ''}]".replace(" ]", "]")


class Conversation:
    def __init__(self, data_dir: Path, history_messages: int = 30, timezone: str = ""):
        self.path = data_dir / "conversation.jsonl"
        self.history_messages = history_messages
        self.timezone = timezone
        self.messages: list[dict[str, Any]] = []
        self._load()

    def _load(self) -> None:
        if not self.path.exists():
            return
        for line in self.path.read_text(encoding="utf-8").splitlines():
            try:
                m = json.loads(line)
            except ValueError:
                continue  # A line cut short by a crash; the rest is still good
            if isinstance(m, dict) and m.get("role") in ("user", "assistant") and isinstance(m.get("content"), str):
                self.messages.append(m)

    def add(self, role: str, content: str, ask: str = "", **extra: Any) -> dict[str, Any]:
        m = {"role": role, "content": content, "at": datetime.now().astimezone().isoformat(timespec="seconds"),
             "ask": ask, **extra}
        self.messages.append(m)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with self.path.open("a", encoding="utf-8") as f:
            f.write(json.dumps(m, ensure_ascii=False) + "\n")
        return m

    def for_model(self, system: str, question: str) -> list[dict[str, Any]]:
        """The messages sent to the model: the persona, recent history, then the new question with the time."""
        recent = [{"role": m["role"], "content": m["content"]}
                  for m in self.messages[-self.history_messages:] if m["content"]]
        # The history must start with a question, or some chat templates refuse it
        while recent and recent[0]["role"] != "user":
            recent.pop(0)
        return [{"role": "system", "content": system}, *recent,
                {"role": "user", "content": f"{now_stamp(self.timezone)} {question}"}]

    def clear(self) -> None:
        """Starts a new conversation. The old one is kept on disk under a dated name, never deleted."""
        if self.path.exists():
            self.path.rename(self.path.with_name(f"conversation-{datetime.now():%Y%m%d-%H%M%S}.jsonl"))
        self.messages = []
