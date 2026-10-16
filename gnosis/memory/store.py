"""Local long-term memory: facts about the owner, task episodes, and their search indexes.

Everything lives in one SQLite file on the laptop. Full-text search (FTS5) always works;
vector search is added when an embedding model is available.
"""

from __future__ import annotations

import array
import math
import sqlite3
import threading
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any

_SCHEMA = """
CREATE TABLE IF NOT EXISTS facts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    subject TEXT NOT NULL,
    predicate TEXT NOT NULL,
    value TEXT NOT NULL,
    source TEXT NOT NULL DEFAULT 'conversation',
    confidence REAL NOT NULL DEFAULT 0.8,
    sensitive INTEGER NOT NULL DEFAULT 0,
    pinned INTEGER NOT NULL DEFAULT 0,
    episode_id INTEGER,
    created REAL NOT NULL,
    updated REAL NOT NULL,
    UNIQUE(subject, predicate)
);
CREATE VIRTUAL TABLE IF NOT EXISTS facts_fts USING fts5(
    subject, predicate, value, content='facts', content_rowid='id', tokenize='porter unicode61'
);
CREATE TRIGGER IF NOT EXISTS facts_ai AFTER INSERT ON facts BEGIN
    INSERT INTO facts_fts(rowid, subject, predicate, value) VALUES (new.id, new.subject, new.predicate, new.value);
END;
CREATE TRIGGER IF NOT EXISTS facts_ad AFTER DELETE ON facts BEGIN
    INSERT INTO facts_fts(facts_fts, rowid, subject, predicate, value) VALUES ('delete', old.id, old.subject, old.predicate, old.value);
    DELETE FROM vectors WHERE kind = 'fact' AND ref_id = old.id;
END;
CREATE TRIGGER IF NOT EXISTS facts_au AFTER UPDATE ON facts BEGIN
    INSERT INTO facts_fts(facts_fts, rowid, subject, predicate, value) VALUES ('delete', old.id, old.subject, old.predicate, old.value);
    INSERT INTO facts_fts(rowid, subject, predicate, value) VALUES (new.id, new.subject, new.predicate, new.value);
END;

CREATE TABLE IF NOT EXISTS episodes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id TEXT,
    request TEXT NOT NULL,
    summary TEXT NOT NULL,
    created REAL NOT NULL
);
CREATE VIRTUAL TABLE IF NOT EXISTS episodes_fts USING fts5(
    request, summary, content='episodes', content_rowid='id', tokenize='porter unicode61'
);
CREATE TRIGGER IF NOT EXISTS episodes_ai AFTER INSERT ON episodes BEGIN
    INSERT INTO episodes_fts(rowid, request, summary) VALUES (new.id, new.request, new.summary);
END;
CREATE TRIGGER IF NOT EXISTS episodes_ad AFTER DELETE ON episodes BEGIN
    INSERT INTO episodes_fts(episodes_fts, rowid, request, summary) VALUES ('delete', old.id, old.request, old.summary);
    DELETE FROM vectors WHERE kind = 'episode' AND ref_id = old.id;
END;

CREATE TABLE IF NOT EXISTS vectors (
    kind TEXT NOT NULL,
    ref_id INTEGER NOT NULL,
    vector BLOB NOT NULL,
    PRIMARY KEY (kind, ref_id)
);
"""

OWNER = "owner"


@dataclass
class Fact:
    id: int
    subject: str
    predicate: str
    value: str
    source: str
    confidence: float
    sensitive: bool
    pinned: bool
    episode_id: int | None
    created: float
    updated: float

    @property
    def text(self) -> str:
        return f"{self.subject} {self.predicate.replace('_', ' ')}: {self.value}"

    def to_dict(self) -> dict[str, Any]:
        return {**self.__dict__, "text": self.text}


@dataclass
class Episode:
    id: int
    task_id: str | None
    request: str
    summary: str
    created: float

    def to_dict(self) -> dict[str, Any]:
        return dict(self.__dict__)


def _norm_subject(s: str) -> str:
    s = " ".join(s.strip().split())
    return OWNER if s.lower() in {"owner", "me", "i", "user", "the user", "the owner", "myself"} else s


def _norm_predicate(p: str) -> str:
    return "_".join(p.strip().lower().split())


def pack(vec: list[float]) -> bytes:
    return array.array("f", vec).tobytes()


def unpack(blob: bytes) -> list[float]:
    a = array.array("f")
    a.frombytes(blob)
    return a.tolist()


def cosine(a: list[float], b: list[float]) -> float:
    dot = sum(x * y for x, y in zip(a, b))
    na = math.sqrt(sum(x * x for x in a))
    nb = math.sqrt(sum(y * y for y in b))
    return dot / (na * nb) if na and nb else 0.0


def fts_query(text: str) -> str | None:
    """Turns free text into a safe FTS5 OR-query of its words."""
    words = ["".join(ch for ch in w if ch.isalnum()) for w in text.split()]
    words = [w for w in words if len(w) > 1]
    return " OR ".join(f'"{w}"' for w in words) or None


class MemoryStore:
    def __init__(self, db_path: Path | str):
        self._lock = threading.RLock()
        self._db = sqlite3.connect(str(db_path), check_same_thread=False)
        self._db.row_factory = sqlite3.Row
        self._db.execute("PRAGMA foreign_keys = ON")
        self._db.executescript(_SCHEMA)

    # ---- facts -------------------------------------------------------------

    def upsert_fact(self, subject: str, predicate: str, value: str, *, source: str = "conversation",
                    confidence: float = 0.8, sensitive: bool = False,
                    episode_id: int | None = None) -> tuple[Fact, bool]:
        """Saves a fact; a newer value for the same subject and predicate replaces the old one.

        Returns the fact and whether it changed. A pinned fact is never overwritten by extraction.
        """
        subject, predicate, value = _norm_subject(subject), _norm_predicate(predicate), value.strip()
        if not (subject and predicate and value):
            raise ValueError("A fact needs a subject, predicate and value")
        now = time.time()
        with self._lock:
            row = self._db.execute("SELECT * FROM facts WHERE subject = ? AND predicate = ?",
                                   (subject, predicate)).fetchone()
            if row is None:
                cur = self._db.execute(
                    "INSERT INTO facts (subject, predicate, value, source, confidence, sensitive,"
                    " episode_id, created, updated) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
                    (subject, predicate, value, source, confidence, int(sensitive), episode_id, now, now))
                self._db.commit()
                return self.get_fact(cur.lastrowid), True
            existing = Fact(**dict(row))
            if existing.value == value or (existing.pinned and source != "explicit"):
                return existing, False
            self._db.execute(
                "UPDATE facts SET value = ?, source = ?, confidence = ?, sensitive = ?, episode_id = ?,"
                " updated = ? WHERE id = ?",
                (value, source, confidence, int(sensitive or existing.sensitive), episode_id, now, existing.id))
            self._db.execute("DELETE FROM vectors WHERE kind = 'fact' AND ref_id = ?", (existing.id,))
            self._db.commit()
            return self.get_fact(existing.id), True

    def get_fact(self, fact_id: int) -> Fact | None:
        with self._lock:
            row = self._db.execute("SELECT * FROM facts WHERE id = ?", (fact_id,)).fetchone()
        return Fact(**dict(row)) if row else None

    def facts(self, include_sensitive: bool = True) -> list[Fact]:
        sql = "SELECT * FROM facts" + ("" if include_sensitive else " WHERE sensitive = 0")
        with self._lock:
            rows = self._db.execute(sql + " ORDER BY pinned DESC, updated DESC").fetchall()
        return [Fact(**dict(r)) for r in rows]

    def update_fact(self, fact_id: int, *, value: str | None = None, pinned: bool | None = None,
                    sensitive: bool | None = None) -> Fact | None:
        sets, params = [], []
        for col, val in (("value", value), ("pinned", pinned), ("sensitive", sensitive)):
            if val is not None:
                sets.append(f"{col} = ?")
                params.append(val.strip() if isinstance(val, str) else int(val))
        if not sets:
            return self.get_fact(fact_id)
        with self._lock:
            self._db.execute(f"UPDATE facts SET {', '.join(sets)}, updated = ? WHERE id = ?",
                             (*params, time.time(), fact_id))
            if value is not None:
                self._db.execute("DELETE FROM vectors WHERE kind = 'fact' AND ref_id = ?", (fact_id,))
            self._db.commit()
        return self.get_fact(fact_id)

    def delete_fact(self, fact_id: int) -> bool:
        with self._lock:
            cur = self._db.execute("DELETE FROM facts WHERE id = ?", (fact_id,))
            self._db.commit()
        return cur.rowcount > 0

    # ---- episodes ----------------------------------------------------------

    def add_episode(self, request: str, summary: str, task_id: str | None = None) -> Episode:
        with self._lock:
            cur = self._db.execute(
                "INSERT INTO episodes (task_id, request, summary, created) VALUES (?, ?, ?, ?)",
                (task_id, request, summary, time.time()))
            self._db.commit()
            row = self._db.execute("SELECT * FROM episodes WHERE id = ?", (cur.lastrowid,)).fetchone()
        return Episode(**dict(row))

    def episodes(self, limit: int = 50) -> list[Episode]:
        with self._lock:
            rows = self._db.execute("SELECT * FROM episodes ORDER BY id DESC LIMIT ?", (limit,)).fetchall()
        return [Episode(**dict(r)) for r in rows]

    def delete_episode(self, episode_id: int) -> bool:
        with self._lock:
            cur = self._db.execute("DELETE FROM episodes WHERE id = ?", (episode_id,))
            self._db.commit()
        return cur.rowcount > 0

    # ---- search ------------------------------------------------------------

    def search_text(self, kind: str, query: str, limit: int = 20) -> list[tuple[int, float]]:
        """(id, score) pairs from full-text search; higher score is better."""
        q = fts_query(query)
        if q is None:
            return []
        table = {"fact": "facts_fts", "episode": "episodes_fts"}[kind]
        with self._lock:
            rows = self._db.execute(
                f"SELECT rowid, bm25({table}) FROM {table} WHERE {table} MATCH ? ORDER BY 2 LIMIT ?",
                (q, limit)).fetchall()
        return [(r[0], -r[1]) for r in rows]  # bm25 is lower-is-better

    def set_vector(self, kind: str, ref_id: int, vector: list[float]) -> None:
        with self._lock:
            self._db.execute("INSERT OR REPLACE INTO vectors (kind, ref_id, vector) VALUES (?, ?, ?)",
                             (kind, ref_id, pack(vector)))
            self._db.commit()

    def missing_vectors(self, kind: str) -> list[tuple[int, str]]:
        """Items that still need an embedding, as (id, text)."""
        if kind == "fact":
            sql = ("SELECT f.id, f.subject || ' ' || replace(f.predicate, '_', ' ') || ': ' || f.value FROM facts f"
                   " LEFT JOIN vectors v ON v.kind = 'fact' AND v.ref_id = f.id WHERE v.ref_id IS NULL")
        else:
            sql = ("SELECT e.id, e.request || ' ' || e.summary FROM episodes e"
                   " LEFT JOIN vectors v ON v.kind = 'episode' AND v.ref_id = e.id WHERE v.ref_id IS NULL")
        with self._lock:
            return [(r[0], r[1]) for r in self._db.execute(sql).fetchall()]

    def search_vector(self, kind: str, query_vec: list[float], limit: int = 20) -> list[tuple[int, float]]:
        with self._lock:
            rows = self._db.execute("SELECT ref_id, vector FROM vectors WHERE kind = ?", (kind,)).fetchall()
        scored = [(r[0], cosine(query_vec, unpack(r[1]))) for r in rows]
        scored.sort(key=lambda x: x[1], reverse=True)
        return scored[:limit]

    def get_episode(self, episode_id: int) -> Episode | None:
        with self._lock:
            row = self._db.execute("SELECT * FROM episodes WHERE id = ?", (episode_id,)).fetchone()
        return Episode(**dict(row)) if row else None

    def close(self) -> None:
        self._db.close()
