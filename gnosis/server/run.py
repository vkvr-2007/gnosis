"""Runs Gnosis's server and its background work: from `gnosis serve`, or on a thread behind the app window."""

from __future__ import annotations

import asyncio

from gnosis.config import Settings


class GnosisServer:
    def __init__(self, settings: Settings, voice: bool = False):
        import uvicorn

        from gnosis.app import build
        from gnosis.server.api import create_app

        self.settings = settings
        self.voice = voice
        self.g = build(settings)
        self.uvicorn = uvicorn.Server(uvicorn.Config(create_app(self.g), host=settings.host, port=settings.port,
                                                     log_level="warning"))

    @property
    def url(self) -> str:
        return f"http://{self.settings.host}:{self.settings.port}"

    async def serve(self) -> None:
        from gnosis import killswitch

        killswitch.start(self.g.stop_all, self.settings.kill_switch)
        background = [asyncio.create_task(self.g.run_background())]
        if self.voice:
            from gnosis.voice import run_voice

            background.append(asyncio.create_task(run_voice(self.g)))
        for task in background:
            task.add_done_callback(self._report)
        try:
            await self.uvicorn.serve()
        finally:
            for task in background:
                task.cancel()

    def _report(self, task: asyncio.Task) -> None:
        if task.cancelled() or not task.exception():
            return
        e = task.exception()
        print(f"Stopped: {type(e).__name__}: {e}")
        self.g.audit.write("error", where="background", error=f"{type(e).__name__}: {e}")  # For diagnostics

    def stop(self) -> None:
        """Safe from any thread: uvicorn checks this flag and shuts down cleanly."""
        self.uvicorn.should_exit = True
