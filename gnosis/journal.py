"""What happened, kept two ways: the audit log on disk and the diagnostics the D panel shows.

Neither ever records an API key. Text is clipped so the logs stay small.
"""

from __future__ import annotations

import json
import time
from collections import deque
from datetime import datetime
from pathlib import Path
from typing import Any

_CLIP = 500


def _clip(value: Any) -> Any:
    if isinstance(value, str) and len(value) > _CLIP:
        return value[:_CLIP] + "…"
    return value


class Journal:
    def __init__(self, data_dir: Path | None, keep: int = 300):
        self.dir = data_dir / "logs" if data_dir else None
        self.recent: deque[dict[str, Any]] = deque(maxlen=keep)

    def log(self, kind: str, **fields: Any) -> dict[str, Any]:
        """`kind` names the event (question, answer, error, dropped, model_check, ...)."""
        rec = {"t": datetime.now().astimezone().isoformat(timespec="milliseconds"), "kind": kind,
               **{k: _clip(v) for k, v in fields.items()}}
        self.recent.append(rec)
        if self.dir:
            try:
                self.dir.mkdir(parents=True, exist_ok=True)
                with (self.dir / f"{time.strftime('%Y-%m-%d')}.jsonl").open("a", encoding="utf-8") as f:
                    f.write(json.dumps(rec, ensure_ascii=False) + "\n")
            except OSError:
                pass  # A full or locked disk must never stop Gnosis from answering
        return rec

    def tail(self, n: int = 100) -> list[dict[str, Any]]:
        return list(self.recent)[-n:]
