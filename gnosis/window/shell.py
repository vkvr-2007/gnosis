"""Gnosis in its own window (pywebview) with a tray icon (pystray). Closing the window hides it to the tray;
Quit in the tray menu really stops Gnosis."""

from __future__ import annotations

import asyncio
import threading
import time
from typing import Any

import httpx

from gnosis.config import Settings
from gnosis.window import single
from gnosis.window.icon import icon_image

_SHOW_DIAGNOSTICS = "document.querySelector('.tab[data-view=diag]')?.click()"


def healthy(url: str, timeout: float = 1.0) -> bool:
    try:
        return httpx.get(f"{url}/api/health", timeout=timeout).status_code == 200
    except httpx.HTTPError:
        return False


def wait_until_healthy(url: str, timeout_s: float = 90.0, alive=lambda: True) -> bool:
    deadline = time.monotonic() + timeout_s
    while time.monotonic() < deadline and alive():
        if healthy(url):
            return True
        time.sleep(0.25)
    return False


class Shell:
    def __init__(self, url: str, server: Any = None, webview: Any = None, tray: Any = None):
        if webview is None:
            import webview  # Imported here so the server and tests never need a GUI
        self.webview = webview
        self._pystray = tray
        self.url = url
        self.server = server  # None when the window uses a server that was already running
        self.quitting = False
        self.tray = None
        self.window = webview.create_window("Gnosis", url=url, width=1280, height=820, min_size=(720, 520),
                                            background_color="#0b0f14", text_select=True)
        self.window.events.closing += self._on_closing

    def _on_closing(self) -> bool:
        if self.quitting:
            return True
        self.hide()
        return False  # Closing only hides; Quit is in the tray menu

    def show(self) -> None:
        self.window.show()
        self.window.restore()

    def hide(self) -> None:
        self.window.hide()

    def show_diagnostics(self) -> None:
        self.show()
        self.window.evaluate_js(_SHOW_DIAGNOSTICS)

    def stop_everything(self) -> None:
        try:
            httpx.post(f"{self.url}/api/stop", timeout=5)
        except httpx.HTTPError:
            pass

    def quit(self) -> None:
        self.quitting = True
        if self.tray:
            self.tray.stop()
        if self.server:
            self.server.stop()
        self.window.destroy()

    def _make_tray(self) -> None:
        pystray = self._pystray
        if pystray is None:
            import pystray
        self.tray = pystray.Icon("gnosis", icon_image(64), "Gnosis", menu=pystray.Menu(
            pystray.MenuItem("Open Gnosis", lambda *_: self.show(), default=True),
            pystray.MenuItem("Diagnostics", lambda *_: self.show_diagnostics()),
            pystray.MenuItem("Stop everything", lambda *_: self.stop_everything()),
            pystray.Menu.SEPARATOR,
            pystray.MenuItem("Quit Gnosis", lambda *_: self.quit()),
        ))
        self.tray.run_detached()

    def run(self) -> None:
        def started() -> None:
            try:
                self._make_tray()
            except Exception as e:  # No tray (some Linux desktops): the window still works, closing really closes
                print(f"No tray icon ({type(e).__name__}: {e}); closing the window will quit Gnosis.")
                self.quitting = True
        self.webview.start(started, private_mode=False)  # Returns once the window is destroyed


def run_app(settings: Settings, voice: bool = False) -> int:
    holder: dict[str, Shell] = {}
    claimed = single.claim(lambda: holder["shell"].show() if "shell" in holder else None)
    if claimed is None:
        print("Gnosis is already open; brought its window to the front.")
        return 0

    url = f"http://127.0.0.1:{settings.port}"
    server = None
    if healthy(url):
        print(f"Using the Gnosis server that's already running at {url}.")
    else:
        from gnosis.server.run import GnosisServer

        server = GnosisServer(settings, voice=voice)
        thread = threading.Thread(target=lambda: asyncio.run(server.serve()), name="gnosis-server", daemon=True)
        thread.start()
        if not wait_until_healthy(url, alive=thread.is_alive):
            print(f"Gnosis's server didn't start on {url}. Is something else using port {settings.port}?")
            server.stop()
            return 1
    try:
        holder["shell"] = Shell(url, server)
        holder["shell"].run()
    finally:
        claimed.close()
        if server:
            server.stop()
            thread.join(timeout=10)
    return 0
