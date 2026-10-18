"""The conversation, kept on disk so it's still there after Gnosis quits and starts again."""

from __future__ import annotations

import sqlite3
import threading
import time
from pathlib import Path
from typing import Any

_SCHEMA = """
CREATE TABLE IF NOT EXISTS conversation (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts REAL NOT NULL,
    session TEXT NOT NULL,
    role TEXT NOT NULL,
    content TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS conversation_session ON conversation (session, id);
"""

# What the window shows: the owner's own conversations, not test runs (`gnosis accept`, `gnosis bench`).
SHOWN_SESSIONS = ("dashboard", "voice", "terminal", "default")


class ConversationStore:
    def __init__(self, db_path: Path | str):
        self._lock = threading.Lock()
        self._db = sqlite3.connect(str(db_path), check_same_thread=False)
        self._db.executescript(_SCHEMA)

    def add(self, session: str, role: str, content: str) -> None:
        with self._lock:
            self._db.execute("INSERT INTO conversation (ts, session, role, content) VALUES (?, ?, ?, ?)",
                             (time.time(), session, role, content))
            self._db.commit()

    def recent(self, session: str, limit: int) -> list[dict[str, Any]]:
        """The last `limit` messages of one session, oldest first, as model messages."""
        with self._lock:
            rows = self._db.execute("SELECT role, content FROM conversation WHERE session = ? "
                                    "ORDER BY id DESC LIMIT ?", (session, limit)).fetchall()
        return [{"role": r, "content": c} for r, c in reversed(rows)]

    def transcript(self, limit: int = 60, sessions: tuple[str, ...] = SHOWN_SESSIONS) -> list[dict[str, Any]]:
        """The last messages across the owner's sessions, oldest first, for the window."""
        marks = ",".join("?" * len(sessions))
        with self._lock:
            rows = self._db.execute(f"SELECT ts, session, role, content FROM conversation WHERE session IN "
                                    f"({marks}) ORDER BY id DESC LIMIT ?", (*sessions, limit)).fetchall()
        return [{"ts": ts, "session": s, "role": r, "content": c} for ts, s, r, c in reversed(rows)]
