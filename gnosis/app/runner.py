"""Runs the core on its own thread and event loop, so the window's thread never waits on the model."""

from __future__ import annotations

import asyncio
import threading
from typing import Any, Callable, Coroutine

from gnosis.core import Core

Listener = Callable[[dict[str, Any]], None]


class CoreRunner:
    def __init__(self, make_core: Callable[[Listener], Core]):
        self.loop = asyncio.new_event_loop()
        self.listeners: list[Listener] = []
        self.core = make_core(self._emit)
        self._thread = threading.Thread(target=self._run, name="gnosis-core", daemon=True)

    def _emit(self, ev: dict[str, Any]) -> None:
        for fn in list(self.listeners):
            fn(ev)

    def _run(self) -> None:
        asyncio.set_event_loop(self.loop)
        self.loop.run_forever()

    def start(self) -> None:
        self._thread.start()
        asyncio.run_coroutine_threadsafe(self.core.start(), self.loop)

    def call(self, coro: Coroutine[Any, Any, Any], timeout: float = 10.0) -> Any:
        """Runs a coroutine on the core's loop and returns its result (from any other thread)."""
        return asyncio.run_coroutine_threadsafe(coro, self.loop).result(timeout)

    def run(self, fn: Callable[[], Any], timeout: float = 10.0) -> Any:
        """Runs a plain function on the core's loop, so it never races with an answer in progress."""
        async def wrapped():
            return fn()
        return self.call(wrapped(), timeout)

    def stop(self) -> None:
        if not self._thread.is_alive():
            return
        try:
            self.call(self.core.interrupt(), timeout=2)
        except Exception:
            pass
        self.loop.call_soon_threadsafe(self.loop.stop)
        self._thread.join(timeout=3)
