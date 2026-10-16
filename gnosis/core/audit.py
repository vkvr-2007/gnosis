"""Append-only local audit log of everything Gnosis does."""

from __future__ import annotations

import json
import sqlite3
import threading
import time
from pathlib import Path
from typing import Any

_SCHEMA = """
CREATE TABLE IF NOT EXISTS audit (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts REAL NOT NULL,
    kind TEXT NOT NULL,
    data TEXT NOT NULL
);
CREATE TRIGGER IF NOT EXISTS audit_no_update BEFORE UPDATE ON audit
BEGIN SELECT RAISE(ABORT, 'audit log is append-only'); END;
CREATE TRIGGER IF NOT EXISTS audit_no_delete BEFORE DELETE ON audit
BEGIN SELECT RAISE(ABORT, 'audit log is append-only'); END;
"""


class AuditLog:
    def __init__(self, db_path: Path | str):
        self._lock = threading.Lock()
        self._db = sqlite3.connect(str(db_path), check_same_thread=False)
        self._db.executescript(_SCHEMA)

    def write(self, kind: str, **data: Any) -> int:
        with self._lock:
            cur = self._db.execute(
                "INSERT INTO audit (ts, kind, data) VALUES (?, ?, ?)",
                (time.time(), kind, json.dumps(data, default=str)),
            )
            self._db.commit()
            return cur.lastrowid

    def recent(self, limit: int = 100) -> list[dict[str, Any]]:
        with self._lock:
            rows = self._db.execute(
                "SELECT id, ts, kind, data FROM audit ORDER BY id DESC LIMIT ?", (limit,)
            ).fetchall()
        return [{"id": i, "ts": ts, "kind": k, **json.loads(d)} for i, ts, k, d in rows]

    def close(self) -> None:
        self._db.close()
