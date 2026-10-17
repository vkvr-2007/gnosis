"""In-process event bus that feeds the dashboard and phone over WebSocket."""

from __future__ import annotations

import asyncio
import time
from typing import Any


class EventBus:
    def __init__(self) -> None:
        self._subscribers: set[asyncio.Queue] = set()
        self.last: dict[str, dict[str, Any]] = {}  # The latest event of each type, e.g. the voice state

    def subscribe(self) -> asyncio.Queue:
        q: asyncio.Queue = asyncio.Queue(maxsize=500)
        self._subscribers.add(q)
        return q

    def unsubscribe(self, q: asyncio.Queue) -> None:
        self._subscribers.discard(q)

    async def publish(self, type_: str, **data: Any) -> None:
        event = {"type": type_, "ts": time.time(), **data}
        self.last[type_] = event
        for q in list(self._subscribers):
            if q.full():  # A slow client drops its oldest event rather than blocking Gnosis.
                q.get_nowait()
            q.put_nowait(event)
