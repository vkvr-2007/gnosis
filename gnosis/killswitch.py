"""Global kill switch hotkey (Ctrl+Alt+J by default) that stops everything Gnosis is doing."""

from __future__ import annotations

import asyncio
import sys
import threading
from typing import Awaitable, Callable

_MODS = {"alt": 0x0001, "ctrl": 0x0002, "control": 0x0002, "shift": 0x0004, "win": 0x0008}
_NAMED = {"space": 0x20, "enter": 0x0D, "esc": 0x1B, "escape": 0x1B}
_MOD_NOREPEAT = 0x4000
_WM_HOTKEY = 0x0312


def parse_hotkey(combo: str) -> tuple[int, int]:
    """'ctrl+alt+j' -> (modifier flags, virtual key code)."""
    parts = [p.strip().lower() for p in combo.split("+") if p.strip()]
    mods, key = 0, None
    for p in parts:
        if p in _MODS:
            mods |= _MODS[p]
        elif p in _NAMED:
            key = _NAMED[p]
        elif len(p) == 1 and p.isalnum():
            key = ord(p.upper())
        elif p.startswith("f") and p[1:].isdigit() and 1 <= int(p[1:]) <= 12:
            key = 0x70 + int(p[1:]) - 1
        else:
            raise ValueError(f"Unsupported key in hotkey: {p}")
    if key is None or not mods:
        raise ValueError("A hotkey needs at least one modifier and one key, e.g. ctrl+alt+j")
    return mods | _MOD_NOREPEAT, key


def start(on_press: Callable[[], Awaitable[object]], combo: str = "ctrl+alt+j",
          name: str = "Kill switch") -> threading.Thread | None:
    """Listens for the hotkey on a background thread (Windows only). Returns None elsewhere.
    Also used for the push-to-talk key."""
    if sys.platform != "win32":
        return None
    import ctypes
    from ctypes import wintypes

    loop = asyncio.get_running_loop()
    mods, vk = parse_hotkey(combo)

    def listen() -> None:
        user32 = ctypes.windll.user32
        if not user32.RegisterHotKey(None, 1, mods, vk):
            print(f"{name}: couldn't register {combo} (another app may be using it)")
            return
        msg = wintypes.MSG()
        while user32.GetMessageW(ctypes.byref(msg), None, 0, 0) != 0:
            if msg.message == _WM_HOTKEY:
                asyncio.run_coroutine_threadsafe(on_press(), loop)

    thread = threading.Thread(target=listen, name=f"gnosis-hotkey-{combo}", daemon=True)
    thread.start()
    return thread
