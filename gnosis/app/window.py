"""The Gnosis window (pywebview) and its tray icon (pystray)."""

from __future__ import annotations

import json
import queue
import threading
from pathlib import Path
from typing import Any

from gnosis.app import single
from gnosis.app.icon import icon_image
from gnosis.app.runner import CoreRunner
from gnosis.core import Core
from gnosis.identity import Identity
from gnosis.settings import Settings

UI = Path(__file__).resolve().parent / "ui" / "index.html"


class Api:
    """What the page can call, as window.pywebview.api.<name>(). Every call returns plain JSON."""

    def __init__(self, runner: CoreRunner, shell: "Shell"):
        self._runner = runner
        self._shell = shell

    def ask(self, text: str) -> dict[str, Any]:
        try:
            return {"ask": self._runner.call(self._runner.core.ask(str(text)))}
        except ValueError:
            return {"error": "Type a question first."}

    def interrupt(self) -> dict[str, Any]:
        return {"ask": self._runner.call(self._runner.core.interrupt())}

    def history(self) -> list[dict[str, Any]]:
        return self._runner.run(self._runner.core.history)

    def status(self) -> dict[str, Any]:
        return self._runner.run(self._runner.core.status)

    def diagnostics(self) -> list[dict[str, Any]]:
        return self._runner.run(lambda: self._runner.core.journal.tail(150))

    def new_chat(self) -> dict[str, Any]:
        self._runner.call(self._runner.core.interrupt())
        self._runner.run(self._runner.core.new_chat)
        return {"ok": True}

    def recheck(self) -> dict[str, Any]:
        return vars(self._runner.call(self._runner.core.start(), timeout=90))

    def hide(self) -> None:
        self._shell.hide()


class Shell:
    def __init__(self, settings: Settings, identity: Identity):
        import webview  # Imported here so the core and tests never need a GUI

        self.webview = webview
        self.identity = identity
        self.quitting = False
        self.tray = None
        self.runner = CoreRunner(lambda emit: Core(settings, identity, emit=emit))
        self.api = Api(self.runner, self)
        self.window = webview.create_window(
            identity.name, url=str(UI), js_api=self.api, width=520, height=760, min_size=(400, 520),
            background_color="#0d1117", text_select=True)
        self.window.events.closing += self._on_closing
        self._pending: queue.Queue[dict[str, Any] | None] = queue.Queue()
        self.runner.listeners.append(self._pending.put)

    def _push(self) -> None:
        """Sends core events to the page on its own thread: evaluate_js waits for the page, the core must not."""
        while (ev := self._pending.get()) is not None:
            try:
                self.window.evaluate_js(f"window.gnosisReceive && window.gnosisReceive({json.dumps(ev)})")
            except Exception:
                pass  # The page is reloading; it re-reads the conversation when it's back

    def _on_closing(self) -> bool:
        if self.quitting:
            return True
        self.hide()
        return False  # Closing the window only hides it; Quit is in the tray menu

    def show(self) -> None:
        self.window.show()
        self.window.restore()

    def hide(self) -> None:
        self.window.hide()

    def quit(self) -> None:
        self.quitting = True
        self._pending.put(None)
        if self.tray:
            self.tray.stop()
        self.runner.stop()
        self.window.destroy()

    def _tray(self) -> None:
        import pystray

        def new_chat(*_):
            self.api.new_chat()
            self.window.evaluate_js("window.gnosisReload && window.gnosisReload()")

        self.tray = pystray.Icon("gnosis", icon_image(64), self.identity.name, menu=pystray.Menu(
            pystray.MenuItem(f"Open {self.identity.name}", lambda *_: self.show(), default=True),
            pystray.MenuItem("New chat", new_chat),
            pystray.Menu.SEPARATOR,
            pystray.MenuItem("Quit", lambda *_: self.quit()),
        ))
        self.tray.run_detached()

    def run(self) -> None:
        def started():
            self.runner.start()
            threading.Thread(target=self._push, name="gnosis-push", daemon=True).start()
            try:
                self._tray()
            except Exception:
                pass  # No tray (e.g. some Linux desktops): the window still works, it just closes for real
        self.webview.start(started, private_mode=False)


def run_app(settings: Settings, identity: Identity) -> int:
    holder: dict[str, Shell] = {}
    if not single.claim(lambda: holder["shell"].show() if "shell" in holder else None):
        print(f"{identity.name} is already running; brought it to the front.")
        return 0
    holder["shell"] = Shell(settings, identity)
    holder["shell"].run()
    return 0
