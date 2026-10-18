"""Reading and operating app windows through Windows UI Automation (the accessibility tree).

This is the primary way Gnosis works inside apps: it finds buttons and fields by name, which is faster
and more reliable than clicking pixels. Screenshots are the fallback (see vision.py).
"""

from __future__ import annotations

import ctypes
import sys
from dataclasses import dataclass
from typing import Any, Iterable

_INTERACTIVE = {
    "ButtonControl", "EditControl", "HyperlinkControl", "ListItemControl", "MenuItemControl",
    "TabItemControl", "CheckBoxControl", "ComboBoxControl", "RadioButtonControl", "TreeItemControl",
    "SplitButtonControl", "DataItemControl", "DocumentControl", "SliderControl",
}
_KEY_NAMES = {
    "ctrl": "Ctrl", "control": "Ctrl", "alt": "Alt", "shift": "Shift", "win": "Win", "windows": "Win",
    "enter": "Enter", "return": "Enter", "esc": "Esc", "escape": "Esc", "tab": "Tab", "space": "Space",
    "backspace": "Back", "delete": "Delete", "del": "Delete", "home": "Home", "end": "End",
    "pageup": "PageUp", "pagedown": "PageDown", "up": "Up", "down": "Down", "left": "Left", "right": "Right",
    "insert": "Insert", "printscreen": "PrintScreen",
    **{f"f{i}": f"F{i}" for i in range(1, 13)},
}
_MODIFIERS = {"Ctrl", "Alt", "Shift", "Win"}


def escape_text(text: str) -> str:
    """Escapes text so uiautomation.SendKeys types it literally."""
    out = []
    for ch in text:
        if ch in "{}()":
            out.append("{" + ch + "}")
        elif ch == "\n":
            out.append("{Enter}")
        elif ch == "\t":
            out.append("{Tab}")
        else:
            out.append(ch)
    return "".join(out)


def combo_to_sendkeys(combo: str) -> str:
    """'ctrl+shift+s' -> '{Ctrl}{Shift}s'. Several combos can be space-separated: 'ctrl+a delete'."""
    result = []
    for part in combo.split():
        keys = [k.strip() for k in part.split("+") if k.strip()]
        if not keys:
            continue
        for k in keys:
            name = _KEY_NAMES.get(k.lower())
            if name:
                result.append("{" + name + "}")
            elif len(k) == 1:
                result.append(escape_text(k.lower()))
            else:
                raise ValueError(f"Unknown key: {k}")
    return "".join(result)


@dataclass
class Element:
    id: int
    type: str
    name: str
    value: str
    rect: tuple[int, int, int, int]  # left, top, right, bottom in screen pixels
    control: Any = None

    @property
    def center(self) -> tuple[int, int]:
        l, t, r, b = self.rect
        return (l + r) // 2, (t + b) // 2

    def line(self) -> str:
        label = self.type.removesuffix("Control")
        text = f"[{self.id}] {label} '{self.name}'" if self.name else f"[{self.id}] {label}"
        if self.type == "DocumentControl" and self.value:
            # A document's contents can be long and personal; read_screen reads them on request.
            text += f" ({len(self.value)} characters of text)"
        elif self.value and self.value != self.name:
            text += f" = '{self.value[:60]}'"
        return text


def collect(walk: Iterable[tuple[Any, int]], limit: int = 80) -> list[Element]:
    """Picks the visible, useful controls out of a UI Automation tree walk."""
    elements: list[Element] = []
    for control, _depth in walk:
        try:
            ctype = control.ControlTypeName
            name = (control.Name or "").strip()
            if ctype not in _INTERACTIVE and not (ctype == "TextControl" and name):
                continue
            if control.IsOffscreen or not control.IsEnabled:
                continue
            r = control.BoundingRectangle
            if r.width() <= 2 or r.height() <= 2:
                continue
            value = ""
            if ctype in ("EditControl", "ComboBoxControl", "DocumentControl"):
                try:
                    value = control.GetValuePattern().Value or ""
                except Exception:
                    value = ""
        except Exception:
            continue  # Controls can vanish mid-walk
        elements.append(Element(len(elements) + 1, ctype, name[:80], value, (r.left, r.top, r.right, r.bottom), control))
        if len(elements) >= limit:
            break
    return elements


class Desktop:
    """Live access to the Windows desktop. Only constructed on Windows."""

    def __init__(self) -> None:
        if sys.platform != "win32":
            raise RuntimeError("Desktop control only works on Windows")
        import uiautomation as auto

        self.auto = auto
        try:
            auto.SetProcessDpiAwareness(2)  # So UIA rectangles and clicks use the same pixels
        except Exception:
            pass
        auto.SetGlobalSearchTimeout(2)
        self.last: list[Element] = []
        self.last_window: str = ""

    # ---- windows -----------------------------------------------------------

    def windows(self) -> list[dict]:
        import psutil

        out = []
        for w in self.auto.GetRootControl().GetChildren():
            try:
                if w.ControlTypeName != "WindowControl" or not w.Name or w.IsOffscreen:
                    continue
                proc = psutil.Process(w.ProcessId).name()
            except Exception:
                continue
            out.append({"title": w.Name, "app": proc.removesuffix(".exe"), "handle": w.NativeWindowHandle})
        return out

    def find_windows(self, query: str) -> list[dict]:
        q = query.lower().removesuffix(".exe")
        return [w for w in self.windows() if q in w["title"].lower() or q in w["app"].lower()]

    def close_window(self, handle: int) -> None:
        WM_CLOSE = 0x0010
        ctypes.windll.user32.PostMessageW(handle, WM_CLOSE, 0, 0)  # Graceful: the app can ask to save

    def focus_window(self, handle: int) -> None:
        SW_RESTORE = 9
        user32 = ctypes.windll.user32
        if user32.IsIconic(handle):
            user32.ShowWindow(handle, SW_RESTORE)
        user32.SetForegroundWindow(handle)

    def foreground(self) -> dict:
        import psutil

        c = self.auto.GetForegroundControl()
        top = c.GetTopLevelControl() or c
        try:
            app = psutil.Process(top.ProcessId).name().removesuffix(".exe")
        except Exception:
            app = ""
        return {"title": top.Name, "app": app, "handle": top.NativeWindowHandle, "control": top,
                "pid": top.ProcessId}

    # ---- inside the window -------------------------------------------------

    def snapshot(self, limit: int = 80) -> tuple[dict, list[Element]]:
        fg = self.foreground()
        elements = collect(self.auto.WalkControl(fg["control"], maxDepth=25), limit)
        self.last, self.last_window = elements, fg["title"]
        return fg, elements

    def element(self, element_id: int) -> Element:
        for e in self.last:
            if e.id == element_id:
                return e
        raise ValueError(f"No element [{element_id}]; take a fresh look at the window first")

    def click(self, element_id: int, double: bool = False) -> str:
        e = self.element(element_id)
        try:
            if not double and e.type in ("ButtonControl", "MenuItemControl", "HyperlinkControl", "SplitButtonControl"):
                e.control.GetInvokePattern().Invoke()
                return f"Pressed {e.line()}"
        except Exception:
            pass  # Not every control supports Invoke; fall back to a real click.
        x, y = e.center
        self.click_at(x, y, double)
        return f"Clicked {e.line()}"

    def click_at(self, x: int, y: int, double: bool = False) -> None:
        self.auto.Click(x, y)
        if double:
            self.auto.Click(x, y)

    def type_text(self, text: str, element_id: int | None = None, replace: bool = False) -> str:
        if element_id is not None:
            e = self.element(element_id)
            if replace:
                try:
                    e.control.GetValuePattern().SetValue(text)
                    return f"Set {e.line()} to '{text[:60]}'"
                except Exception:
                    pass
            e.control.SetFocus()
            if replace:
                self.auto.SendKeys("{Ctrl}a{Delete}")
        self.auto.SendKeys(escape_text(text), interval=0.005)
        return f"Typed {len(text)} characters"

    def typing_target(self, element_id: int | None = None) -> dict:
        """What type_text would type into: the control type and how much text it already holds."""
        control = self.element(element_id).control if element_id is not None else self.auto.GetFocusedControl()
        chars = None
        try:
            chars = len(control.GetValuePattern().Value or "")
        except Exception:
            try:
                chars = len(control.GetTextPattern().DocumentRange.GetText(-1) or "")
            except Exception:
                pass
        return {"window": self.foreground()["title"], "type": control.ControlTypeName, "chars": chars}

    def press(self, combo: str) -> str:
        self.auto.SendKeys(combo_to_sendkeys(combo))
        return f"Pressed {combo}"

    def find_by_name(self, name: str, types: set[str] | None = None) -> Element | None:
        _, elements = self.snapshot()
        name = name.lower()
        for e in elements:
            if (types is None or e.type in types) and name in e.name.lower():
                return e
        return None
