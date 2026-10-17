"""Teach mode: records what you do in Windows apps and turns it into skill steps.

Each click is saved as the button or field you clicked (its name in the accessibility tree), not as a
screen position, so the skill still works when windows move. Typing into password fields is never
recorded, and nothing is recorded while an app on the skip list is in front.
"""

from __future__ import annotations

import queue
import sys
import threading
import time
from typing import Any

DEFAULT_SKIP_APPS = ("keepass", "1password", "bitwarden", "lastpass", "dashlane")
_SPECIAL = {"enter": "enter", "tab": "tab", "esc": "esc", "backspace": "backspace", "delete": "delete",
            "up": "up", "down": "down", "left": "left", "right": "right", "home": "home", "end": "end",
            "page_up": "pageup", "page_down": "pagedown", **{f"f{i}": f"f{i}" for i in range(1, 13)}}
_MODS = {"ctrl_l": "ctrl", "ctrl_r": "ctrl", "ctrl": "ctrl", "alt_l": "alt", "alt_r": "alt", "alt_gr": "alt",
         "alt": "alt", "shift": "shift", "shift_l": "shift", "shift_r": "shift", "cmd": "win", "cmd_l": "win",
         "cmd_r": "win"}


def steps_from_trace(events: list[dict[str, Any]]) -> tuple[list[dict[str, Any]], list[str]]:
    """Turns recorded events into skill steps. Returns (steps, notes about anything left out)."""
    steps: list[dict[str, Any]] = []
    notes: list[str] = []
    app = None
    for ev in events:
        kind = ev["kind"]
        last = steps[-1] if steps else None
        if kind == "click":
            if ev.get("app") and ev["app"] != app:
                app = ev["app"]
                steps.append({"tool": "focus_window", "args": {"name": app}})
            if ev.get("name"):
                args = {"name": ev["name"]}
                if ev.get("type"):
                    args["control_type"] = ev["type"]
                steps.append({"tool": "click_element", "args": args})
            else:
                notes.append(f"A click in {ev.get('app') or 'an app'} on something without a name was left out")
        elif kind == "text":
            if last and last["tool"] == "type_text":
                last["args"]["text"] += ev["text"]
            else:
                steps.append({"tool": "type_text", "args": {"text": ev["text"]}})
        elif kind == "key":
            if last and last["tool"] == "press_keys":
                last["args"]["keys"] += " " + ev["combo"]
            else:
                steps.append({"tool": "press_keys", "args": {"keys": ev["combo"]}})
        elif kind == "skipped":
            notes.append(ev["reason"])
    return steps, notes


class Recorder:
    """Listens to the mouse and keyboard (pynput) and looks up what was clicked (UI Automation)."""

    def __init__(self, skip_apps: tuple[str, ...] = DEFAULT_SKIP_APPS):
        if sys.platform != "win32":
            raise RuntimeError("Teach mode records Windows apps, so it only runs on Windows")
        self.skip_apps = tuple(a.lower() for a in skip_apps)
        self.events: list[dict[str, Any]] = []
        self._raw: queue.Queue = queue.Queue()
        self._mods: set[str] = set()
        self._listeners: list[Any] = []
        self._worker: threading.Thread | None = None
        self.recording = False

    # The input hooks must return quickly, so they only queue raw events; a worker thread does the rest.
    def _on_click(self, x, y, button, pressed) -> None:
        if pressed and self.recording:
            self._raw.put(("click", x, y, time.time()))

    def _on_press(self, key) -> None:
        if not self.recording:
            return
        name = getattr(key, "name", None)
        if name in _MODS:
            self._mods.add(_MODS[name])
            return
        char = getattr(key, "char", None)
        if self._mods - {"shift"}:
            k = (char or name or "").lower()
            if k and len(k) == 1 and ord(k) < 32:  # Ctrl+letter arrives as a control character
                k = chr(ord(k) + 96)
            if k:
                mods = [m for m in ("ctrl", "alt", "shift", "win") if m in self._mods]
                self._raw.put(("key", "+".join([*mods, k]), time.time()))
        elif char:
            self._raw.put(("char", char, time.time()))
        elif name == "space":
            self._raw.put(("char", " ", time.time()))
        elif name in _SPECIAL:
            self._raw.put(("key", _SPECIAL[name], time.time()))

    def _on_release(self, key) -> None:
        name = getattr(key, "name", None)
        if name in _MODS:
            self._mods.discard(_MODS[name])

    def _work(self) -> None:
        import psutil
        import uiautomation as auto

        auto.InitializeUIAutomationInCurrentThread()
        while True:
            item = self._raw.get()
            if item is None:
                return
            try:
                self._handle(item, auto, psutil)
            except Exception:
                continue  # A control that vanished mid-lookup just isn't recorded

    def _handle(self, item, auto, psutil) -> None:
        focused = auto.GetFocusedControl()
        top = focused.GetTopLevelControl() if focused else None
        app = psutil.Process(top.ProcessId).name().removesuffix(".exe") if top else ""
        if any(s in app.lower() for s in self.skip_apps):
            if not self.events or self.events[-1].get("reason") != f"Skipped {app}":
                self.events.append({"kind": "skipped", "reason": f"Skipped {app}"})
            return
        kind = item[0]
        if kind == "click":
            c = auto.ControlFromPoint(item[1], item[2])
            window = c.GetTopLevelControl() if c else None
            app = psutil.Process(window.ProcessId).name().removesuffix(".exe") if window else app
            self.events.append({"kind": "click", "app": app, "window": window.Name if window else "",
                                "name": (c.Name or "").strip()[:80] if c else "",
                                "type": c.ControlTypeName if c else "",
                                "automation_id": c.AutomationId if c else ""})
        elif kind == "char":
            if focused is not None and getattr(focused, "IsPassword", False):
                note = "Typing in a password field wasn't recorded"
                if not self.events or self.events[-1].get("reason") != note:
                    self.events.append({"kind": "skipped", "reason": note})
                return
            self.events.append({"kind": "text", "text": item[1]})
        elif kind == "key":
            self.events.append({"kind": "key", "combo": item[1]})

    def start(self) -> None:
        from pynput import keyboard, mouse

        self.events = []
        self.recording = True
        self._worker = threading.Thread(target=self._work, name="gnosis-teach", daemon=True)
        self._worker.start()
        self._listeners = [mouse.Listener(on_click=self._on_click),
                           keyboard.Listener(on_press=self._on_press, on_release=self._on_release)]
        for listener in self._listeners:
            listener.start()

    def stop(self) -> list[dict[str, Any]]:
        self.recording = False
        for listener in self._listeners:
            listener.stop()
        self._raw.put(None)
        if self._worker:
            self._worker.join(timeout=5)
        return self.events
