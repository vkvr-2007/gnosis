"""Parallel tasks: each request runs as its own worker with a status card, and shared things are locked.

The mouse and keyboard are one resource ("desktop"): the first time a task uses a desktop tool it takes
the lock and keeps it until the task ends, so two tasks never fight over the screen. Tasks that only
use the network, memory or the coder sandbox run side by side.
"""

from __future__ import annotations

import asyncio
import re
import time
from dataclasses import dataclass, field
from typing import Any

# Statuses a task card can show.
QUEUED, RUNNING, WAITING, PAUSED, DONE, FAILED, STOPPED = (
    "queued", "running", "waiting", "paused", "done", "failed", "stopped")
FINISHED = {DONE, FAILED, STOPPED}


@dataclass
class TaskInfo:
    id: str
    text: str
    session: str
    owner: bool = True
    status: str = QUEUED
    detail: str = ""             # What it's doing or waiting for right now
    answer: str | None = None
    created: float = field(default_factory=time.time)
    finished: float | None = None
    steps: int = 0               # Tool calls made so far
    held: set[str] = field(default_factory=set)  # Resources this task holds
    calls: list[dict[str, Any]] = field(default_factory=list)  # Tool calls made, for "save that as a skill"
    gate: asyncio.Event = field(default_factory=asyncio.Event)  # Cleared while paused

    def __post_init__(self) -> None:
        self.gate.set()

    def to_dict(self) -> dict[str, Any]:
        return {"id": self.id, "text": self.text, "session": self.session, "owner": self.owner,
                "status": self.status, "detail": self.detail, "answer": self.answer,
                "created": self.created, "finished": self.finished, "steps": self.steps}


class ResourceLocks:
    def __init__(self) -> None:
        self._locks: dict[str, asyncio.Lock] = {}
        self.holders: dict[str, str] = {}  # resource -> task id

    def lock(self, name: str) -> asyncio.Lock:
        return self._locks.setdefault(name, asyncio.Lock())

    async def acquire(self, name: str, task_id: str) -> None:
        await self.lock(name).acquire()
        self.holders[name] = task_id

    def release(self, name: str) -> None:
        self.holders.pop(name, None)
        lock = self._locks.get(name)
        if lock is not None and lock.locked():
            lock.release()


def match_task(tasks: list[TaskInfo], query: str) -> TaskInfo | None:
    """Finds a task by id, or by the words of its request ("the website one")."""
    query = query.strip().lower()
    for t in tasks:
        if t.id == query:
            return t
    words = {w for w in re.findall(r"\w+", query) if len(w) > 2} - {"the", "one", "task", "that", "this"}
    best, best_score = None, 0
    for t in tasks:
        score = len(words & set(re.findall(r"\w+", t.text.lower())))
        if score > best_score:
            best, best_score = t, score
    return best
