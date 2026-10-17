"""Reminders and routines that fire on time, even when nobody is talking to Gnosis.

Jobs live in the local SQLite file, so they survive restarts. A job that came due while the laptop was
off fires once when Gnosis starts again (marked late), and a repeating job then moves to its next time.
"""

from __future__ import annotations

import asyncio
import datetime as dt
import sqlite3
import threading
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Awaitable, Callable

_SCHEMA = """
CREATE TABLE IF NOT EXISTS jobs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    kind TEXT NOT NULL,              -- reminder | routine | briefing
    text TEXT NOT NULL,              -- What to say, or the goal a routine works on
    next_run REAL NOT NULL,          -- Unix time
    repeat TEXT NOT NULL DEFAULT 'once',
    every INTEGER NOT NULL DEFAULT 0,  -- Minutes, for repeat = 'minutes'
    active INTEGER NOT NULL DEFAULT 1,
    key TEXT UNIQUE,                 -- Fixed name for jobs Gnosis manages itself, e.g. the morning briefing
    created REAL NOT NULL,
    last_run REAL
);
"""

REPEATS = ("once", "daily", "weekdays", "weekly", "hourly", "minutes")


@dataclass
class Job:
    id: int
    kind: str
    text: str
    next_run: float
    repeat: str = "once"
    every: int = 0
    active: bool = True
    key: str | None = None
    created: float = 0.0
    last_run: float | None = None

    def when(self) -> str:
        return dt.datetime.fromtimestamp(self.next_run).strftime("%a %d %b, %H:%M")

    def to_dict(self) -> dict[str, Any]:
        out = {"id": self.id, "kind": self.kind, "text": self.text, "next_run": self.next_run,
               "when": self.when(), "repeat": self.repeat}
        if self.repeat == "minutes":
            out["every_minutes"] = self.every
        return out


def next_after(job: Job, now: float) -> float | None:
    """The first run of a repeating job after `now`, keeping the same time of day. None for one-off jobs."""
    if job.repeat == "once":
        return None
    t = dt.datetime.fromtimestamp(job.next_run)
    step = {"daily": dt.timedelta(days=1), "weekdays": dt.timedelta(days=1), "weekly": dt.timedelta(days=7),
            "hourly": dt.timedelta(hours=1), "minutes": dt.timedelta(minutes=max(job.every, 1))}[job.repeat]
    while t.timestamp() <= now or (job.repeat == "weekdays" and t.weekday() >= 5):
        t += step
    return t.timestamp()


def parse_time(at: str | None, in_minutes: float | None, now: float) -> float:
    """Reads 'at' (an ISO date-time, or just HH:MM for the next time that comes round) or 'in_minutes'."""
    if in_minutes is not None:
        if in_minutes <= 0:
            raise ValueError("in_minutes must be more than 0")
        return now + float(in_minutes) * 60
    if not at:
        raise ValueError("Say when: give 'at' (e.g. 2026-10-18T09:00 or 09:00) or 'in_minutes'")
    at = at.strip()
    try:
        clock = dt.time.fromisoformat(at)
    except ValueError:
        clock = None
    if clock is not None:
        today = dt.datetime.combine(dt.datetime.fromtimestamp(now).date(), clock)
        t = today if today.timestamp() > now else today + dt.timedelta(days=1)
        return t.timestamp()
    parsed = dt.datetime.fromisoformat(at.replace("Z", "+00:00"))
    return parsed.timestamp()  # Naive times are taken as local time


class JobStore:
    def __init__(self, db_path: Path | str):
        self._lock = threading.Lock()
        self._db = sqlite3.connect(str(db_path), check_same_thread=False)
        self._db.row_factory = sqlite3.Row
        self._db.executescript(_SCHEMA)

    def _job(self, row: sqlite3.Row) -> Job:
        return Job(row["id"], row["kind"], row["text"], row["next_run"], row["repeat"], row["every"],
                   bool(row["active"]), row["key"], row["created"], row["last_run"])

    def add(self, kind: str, text: str, next_run: float, repeat: str = "once", every: int = 0,
            key: str | None = None) -> Job:
        if repeat not in REPEATS:
            raise ValueError(f"repeat must be one of {', '.join(REPEATS)}")
        if repeat == "minutes" and every < 1:
            raise ValueError("Give every_minutes for repeat = 'minutes'")
        with self._lock:
            cur = self._db.execute(
                "INSERT INTO jobs (kind, text, next_run, repeat, every, key, created) VALUES (?, ?, ?, ?, ?, ?, ?) "
                "ON CONFLICT(key) DO UPDATE SET text = excluded.text, next_run = excluded.next_run, "
                "repeat = excluded.repeat, every = excluded.every, active = 1",
                (kind, text, next_run, repeat, every, key, time.time()))
            self._db.commit()
            job_id = cur.lastrowid if key is None else \
                self._db.execute("SELECT id FROM jobs WHERE key = ?", (key,)).fetchone()[0]
        return self.get(job_id)

    def get(self, job_id: int) -> Job | None:
        with self._lock:
            row = self._db.execute("SELECT * FROM jobs WHERE id = ?", (job_id,)).fetchone()
        return self._job(row) if row else None

    def upcoming(self) -> list[Job]:
        with self._lock:
            rows = self._db.execute("SELECT * FROM jobs WHERE active = 1 ORDER BY next_run").fetchall()
        return [self._job(r) for r in rows]

    def due(self, now: float) -> list[Job]:
        with self._lock:
            rows = self._db.execute("SELECT * FROM jobs WHERE active = 1 AND next_run <= ? ORDER BY next_run",
                                    (now,)).fetchall()
        return [self._job(r) for r in rows]

    def fired(self, job: Job, now: float) -> None:
        nxt = next_after(job, now)
        with self._lock:
            if nxt is None:
                self._db.execute("UPDATE jobs SET active = 0, last_run = ? WHERE id = ?", (now, job.id))
            else:
                self._db.execute("UPDATE jobs SET next_run = ?, last_run = ? WHERE id = ?", (nxt, now, job.id))
            self._db.commit()

    def cancel(self, job_id: int) -> bool:
        with self._lock:
            cur = self._db.execute("UPDATE jobs SET active = 0 WHERE id = ? AND active = 1", (job_id,))
            self._db.commit()
        return cur.rowcount > 0


FireHandler = Callable[[Job, bool], Awaitable[None]]  # (job, late)


class Scheduler:
    """Wakes when the next job is due (or when jobs change) and hands it to `on_fire`."""

    LATE_AFTER_S = 120  # Fired this long after its time: say so

    def __init__(self, store: JobStore, on_fire: FireHandler, events: Any = None,
                 clock: Callable[[], float] = time.time):
        self.store = store
        self.on_fire = on_fire
        self.events = events
        self.clock = clock
        self._changed = asyncio.Event()

    def add(self, *args: Any, **kwargs: Any) -> Job:
        job = self.store.add(*args, **kwargs)
        self._changed.set()
        return job

    def cancel(self, job_id: int) -> bool:
        ok = self.store.cancel(job_id)
        self._changed.set()
        return ok

    async def tick(self) -> int:
        """Fires every job that's due. Returns how many fired."""
        now = self.clock()
        due = self.store.due(now)
        for job in due:
            self.store.fired(job, now)  # Move it on first, so a slow or failing handler can't fire it twice
            try:
                await self.on_fire(job, now - job.next_run > self.LATE_AFTER_S)
            except Exception as e:
                if self.events:
                    await self.events.publish("job_error", job=job.id, error=f"{type(e).__name__}: {e}")
        if due and self.events:
            await self.events.publish("jobs_changed")
        return len(due)

    async def run(self) -> None:
        while True:
            await self.tick()
            upcoming = self.store.upcoming()
            wait = 30.0 if not upcoming else min(30.0, max(0.2, upcoming[0].next_run - self.clock()))
            try:
                await asyncio.wait_for(self._changed.wait(), wait)
            except asyncio.TimeoutError:
                pass
            self._changed.clear()
