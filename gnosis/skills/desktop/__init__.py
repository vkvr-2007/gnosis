"""Desktop skill: open, close and operate Windows apps.

All UI Automation calls run on one dedicated thread. UIA is a COM API that needs per-thread setup,
and one thread also means only one action touches the mouse and keyboard at a time.
"""

from __future__ import annotations

import asyncio
import functools
import os
import re
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from typing import Any, Callable

from gnosis.core.tools import ToolRegistry
from gnosis.skills.desktop import apps

# Pressing one of these needs the owner's OK even though clicking is normally allowed.
RISKY_BUTTON = re.compile(
    r"\b(send|post|publish|buy|pay|purchase|checkout|place order|order now|delete|remove|uninstall|"
    r"transfer|confirm|submit|sign out|log out|format|erase|reset)\b", re.I)


class DesktopRunner:
    """Owns the UIA thread and the Desktop object living on it."""

    def __init__(self, desktop_factory: Callable[[], Any] | None = None):
        def init() -> None:
            import uiautomation as auto

            auto.InitializeUIAutomationInCurrentThread()

        self._pool = ThreadPoolExecutor(max_workers=1, thread_name_prefix="gnosis-uia",
                                        initializer=init if desktop_factory is None else None)
        self._factory = desktop_factory
        self._desktop = None

    def _get(self):
        if self._desktop is None:
            if self._factory is not None:
                self._desktop = self._factory()
            else:
                from gnosis.skills.desktop.uia import Desktop

                self._desktop = Desktop()
        return self._desktop

    async def run(self, fn: Callable[[Any], Any]) -> Any:
        return await asyncio.get_running_loop().run_in_executor(self._pool, lambda: fn(self._get()))

    @property
    def last_elements(self) -> list:
        return self._desktop.last if self._desktop else []


def _not_gnosis(d) -> None:
    """Typing, clicking and keys never go into Gnosis's own window. Seen on the laptop: after opening
    YouTube, focus came back to Gnosis and "cat video" was typed into Gnosis itself."""
    if d.foreground().get("pid") == os.getpid():
        raise PermissionError("The front window is Gnosis itself, not the app. Bring the app to the front "
                              "first with focus_window, or use play_youtube / open_website for web pages.")


def _wait_for_window(d, name: str, timeout_s: float = 10.0) -> dict | None:
    deadline = time.monotonic() + timeout_s
    words = [w for w in re.split(r"\W+", name.lower()) if len(w) > 2] or [name.lower()]
    while time.monotonic() < deadline:
        for w in d.windows():
            hay = (w["title"] + " " + w["app"]).lower()
            if any(word in hay for word in words):
                return w
        time.sleep(0.5)
    return None


def register_desktop_tools(registry: ToolRegistry, llm: Any, runner: DesktopRunner | None = None,
                           index: apps.AppIndex | None = None) -> bool:
    """Registers desktop tools. Returns False (and registers nothing) when not on Windows."""
    if runner is None and sys.platform != "win32":
        return False
    runner = runner or DesktopRunner()
    index = index or apps.AppIndex()
    # Every desktop tool shares the mouse, keyboard and front window, so one task at a time uses them.
    tool = functools.partial(registry.tool, resource="desktop")

    async def foreground_app(_args: dict) -> str:
        """Screenshot approvals are remembered per app."""
        try:
            return await runner.run(lambda d: d.foreground()["app"]) or "this app"
        except Exception:
            return "this app"

    # ---- apps ----------------------------------------------------------------

    @tool("open_app",
                   "Open an app or game installed on this PC by name (e.g. 'Spotify', 'Valorant', 'VS Code'). "
                   "If it isn't installed, opens its website when there is one.",
                   {"type": "object", "properties": {"name": {"type": "string"}}, "required": ["name"]})
    async def open_app(name: str) -> dict:
        await asyncio.to_thread(index.refresh)
        entry = index.best(name)
        if entry is None:
            url = apps.web_fallback(name)
            if url:
                apps.open_url(url)
                return {"opened_website": url, "note": f"{name} isn't installed, so I opened the website"}
            return {"error": f"I couldn't find an app called '{name}'",
                    "closest": [e.name for e, _ in index.find(name, 3)]}
        before = {w["handle"] for w in await runner.run(lambda d: d.windows())}
        apps.launch(entry)
        window = await runner.run(lambda d: _wait_for_window(d, entry.name, 12))
        if window:
            await runner.run(lambda d: d.focus_window(window["handle"]))
            out = {"opened": entry.name, "window": window["title"]}
            if window["handle"] in before:
                out["note"] = "It was already open, so this window may hold the owner's work"
            return out
        return {"opened": entry.name, "note": "Started it, but its window hasn't appeared yet (games can take a while)"}

    @tool("close_app", "Close an app's windows gracefully (it may ask to save).",
                   {"type": "object", "properties": {"name": {"type": "string"}}, "required": ["name"]})
    async def close_app(name: str) -> dict:
        windows = await runner.run(lambda d: d.find_windows(name))
        if not windows:
            return {"error": f"No open window matches '{name}'"}
        for w in windows:
            await runner.run(lambda d, h=w["handle"]: d.close_window(h))
        return {"closed": [w["title"] for w in windows]}

    @tool("list_windows", "List the open windows and the app each belongs to.")
    async def list_windows() -> list[dict]:
        return [{"title": w["title"], "app": w["app"]} for w in await runner.run(lambda d: d.windows())]

    @tool("focus_window", "Bring an open window to the front.",
                   {"type": "object", "properties": {"name": {"type": "string"}}, "required": ["name"]})
    async def focus_window(name: str) -> dict:
        windows = await runner.run(lambda d: d.find_windows(name))
        if not windows:
            return {"error": f"No open window matches '{name}'"}
        await runner.run(lambda d: d.focus_window(windows[0]["handle"]))
        return {"focused": windows[0]["title"]}

    # ---- inside apps -----------------------------------------------------------

    @tool("look_at_window",
                   "List the buttons, fields and links in the front window, each with an [id]. "
                   "Call this before click or type_text, and again after the window changes.")
    async def look_at_window() -> dict:
        fg, elements = await runner.run(lambda d: d.snapshot())
        return {"window": fg["title"], "app": fg["app"], "elements": [e.line() for e in elements]}

    def risky_click(args: dict) -> str | None:
        for e in runner.last_elements:
            if e.id == args.get("element_id") and RISKY_BUTTON.search(e.name or ""):
                return f"this presses '{e.name}', which may act on your behalf"
        return None

    @tool("click", "Click an element from look_at_window by its id.",
                   {"type": "object", "properties": {
                       "element_id": {"type": "integer"},
                       "double": {"type": "boolean", "description": "Double-click"}},
                    "required": ["element_id"]},
                   escalate=risky_click)
    async def click(element_id: int, double: bool = False) -> str:
        return await runner.run(lambda d: _not_gnosis(d) or d.click(int(element_id), double))

    async def risky_type(args: dict) -> str | None:
        """Typing into a document that already has text could change the owner's work."""
        t = await runner.run(lambda d: d.typing_target(args.get("element_id")))
        chars = t["chars"]
        has_work = ((t["type"] == "DocumentControl" and chars != 0)  # None: couldn't tell, so ask
                    or (t["type"] == "EditControl" and chars is not None and chars > 100))
        return f"this types into '{t['window']}', which already has your text in it" if has_work else None

    @tool("click_element",
          "Click a button, link, tab or menu item in the front window by its visible name (waits a few "
          "seconds for it to appear). Saved skills use this, so they keep working when windows move.",
          {"type": "object", "properties": {
              "name": {"type": "string"},
              "control_type": {"type": "string", "description": "Optional, e.g. ButtonControl"}},
           "required": ["name"]},
          escalate=lambda args: (f"this presses '{args.get('name')}', which may act on your behalf"
                                 if RISKY_BUTTON.search(str(args.get("name", ""))) else None))
    async def click_element(name: str, control_type: str | None = None) -> str:
        def find_and_click(d) -> str | None:
            _not_gnosis(d)
            deadline = time.monotonic() + 6
            while True:
                e = d.find_by_name(name, {control_type} if control_type else None)
                if e is not None:
                    return d.click(e.id)
                if time.monotonic() > deadline:
                    return None
                time.sleep(0.5)

        result = await runner.run(find_and_click)
        if result is None:
            raise LookupError(f"No '{name}' in the front window")
        return result

    @tool("type_text",
                   "Type text into the front window, or into a field from look_at_window. "
                   "Set replace=true to clear the field first.",
                   {"type": "object", "properties": {
                       "text": {"type": "string"},
                       "element_id": {"type": "integer"},
                       "replace": {"type": "boolean"}},
                    "required": ["text"]},
                   escalate=risky_type)
    async def type_text(text: str, element_id: int | None = None, replace: bool = False) -> str:
        return await runner.run(lambda d: _not_gnosis(d) or d.type_text(text, element_id, replace))

    @tool("press_keys", "Press a keyboard shortcut, e.g. 'ctrl+s', 'alt+f4', 'enter', 'ctrl+a delete'.",
                   {"type": "object", "properties": {"keys": {"type": "string"}}, "required": ["keys"]})
    async def press_keys(keys: str) -> str:
        return await runner.run(lambda d: _not_gnosis(d) or d.press(keys))

    # ---- screen ----------------------------------------------------------------

    @tool("read_screen",
                   "Read all the text in the front window: use this for 'what's this?', 'explain this error' "
                   "or 'summarise what I'm reading'. Stays on this laptop.",
                   tags=("screen_text",))
    async def read_screen() -> dict:
        def gather(d) -> dict:
            fg = d.foreground()
            texts, seen, total = [], set(), 0
            for control, _ in d.auto.WalkControl(fg["control"], maxDepth=30):
                try:
                    t = (control.Name or "").strip()
                    if control.ControlTypeName in ("EditControl", "DocumentControl"):
                        t = control.GetValuePattern().Value or t
                except Exception:
                    continue
                if t and t not in seen:
                    seen.add(t)
                    texts.append(t)
                    total += len(t)
                if total > 8000:
                    break
            return {"window": fg["title"], "app": fg["app"], "text": "\n".join(texts)[:8000]}

        return await runner.run(gather)

    @tool("look_at_screen",
                   "Take a screenshot of the front window and ask the vision model about it. Use when "
                   "read_screen has no useful text (images, games, video, charts).",
                   {"type": "object", "properties": {"question": {"type": "string"}}, "required": ["question"]},
                   approval_scope=foreground_app)
    async def look_at_screen(question: str) -> str:
        from gnosis.skills.desktop import vision

        fg = await runner.run(lambda d: d.foreground())
        r = await runner.run(lambda d: fg["control"].BoundingRectangle)
        img, _ = await asyncio.to_thread(vision.capture, (r.left, r.top, r.right, r.bottom))
        # The owner approved sending this app's screenshots to the cloud vision model.
        return await vision.ask_about(llm, img, question, tags=set())

    @tool("vision_click",
                   "Click something described in words using a screenshot, when look_at_window doesn't list it "
                   "(e.g. 'the green play button', 'the first video thumbnail').",
                   {"type": "object", "properties": {"target": {"type": "string"}}, "required": ["target"]},
                   approval_scope=foreground_app)
    async def vision_click(target: str) -> dict:
        from gnosis.skills.desktop import vision

        fg, elements = await runner.run(lambda d: d.snapshot())
        r = await runner.run(lambda d: fg["control"].BoundingRectangle)
        rect = (r.left, r.top, r.right, r.bottom)
        img, origin = await asyncio.to_thread(vision.capture, rect)
        marks = ([vision.Mark(e.id, e.rect) for e in elements] if len(elements) >= 3
                 else vision.grid_marks(origin, img.size))
        marked = vision.draw_marks(img, origin, marks)
        mark = await vision.pick_mark(llm, marked, marks, target, tags=set())
        if mark is None:
            return {"error": f"I couldn't see '{target}' on the screen"}
        if RISKY_BUTTON.search(target):
            return {"error": f"'{target}' looks like it acts on your behalf. Use look_at_window and click "
                             "so you can approve it."}
        x, y = mark.center
        await runner.run(lambda d: _not_gnosis(d) or d.click_at(x, y))
        return {"clicked": target, "at": [x, y]}

    # ---- YouTube and websites -------------------------------------------------------
    # These open a link: no clicking or typing, so they don't need the mouse and keyboard.

    @registry.tool("play_youtube",
                   "Find a video on YouTube and play it in the browser (e.g. 'cat video', 'lofi beats', "
                   "'Interstellar trailer'). Use this for any 'play ... on YouTube' or 'play a ... video'.",
                   {"type": "object", "properties": {"query": {"type": "string"}}, "required": ["query"]})
    async def play_youtube(query: str) -> dict:
        try:
            videos = await asyncio.to_thread(apps.youtube_search, query)
        except Exception as e:
            videos, error = [], f"{type(e).__name__}: {e}"
        else:
            error = None
        if not videos:
            apps.open_url(apps.youtube_search_url(query))
            return {"opened_search": apps.youtube_search_url(query),
                    "note": "Couldn't pick a video" + (f" ({error})" if error else "") +
                            ", so I opened the search results instead. Nothing is playing yet."}
        video = videos[0]
        apps.open_url(video["url"] + "&autoplay=1")
        return {"playing": video["title"], "url": video["url"], "in": "the default browser"}

    @registry.tool("open_website", "Open a web page in the default browser.",
                   {"type": "object", "properties": {"url": {"type": "string"}}, "required": ["url"]})
    async def open_website(url: str) -> dict:
        url = url.strip()
        if not re.match(r"^https?://", url):
            url = "https://" + url
        if not re.match(r"^https?://[\w.-]+(?::\d+)?(?:[/?#]\S*)?$", url):
            return {"error": f"That doesn't look like a web address: {url}"}
        apps.open_url(url)
        return {"opened_website": url}

    # ---- music -----------------------------------------------------------------

    @tool("play_music",
                   "Play a song, artist or playlist on Spotify (the app if installed, otherwise the website). For YouTube "
                   "videos use play_youtube.",
                   {"type": "object", "properties": {"query": {"type": "string"}}, "required": ["query"]})
    async def play_music(query: str) -> dict:
        await asyncio.to_thread(index.refresh)
        if index.best("Spotify") is None:
            apps.open_url(apps.spotify_web_search(query))
            return {"opened_website": apps.spotify_web_search(query),
                    "note": "Spotify isn't installed; opened the web player search. Use vision_click to press play."}
        apps.open_url(apps.spotify_search_uri(query))
        window = await runner.run(lambda d: _wait_for_window(d, "Spotify", 10))
        if not window:
            return {"error": "Spotify didn't open"}
        await runner.run(lambda d: d.focus_window(window["handle"]))
        await asyncio.sleep(2.5)  # Let the search results render

        def press_play(d) -> str | None:
            q = query.lower()
            _, elements = d.snapshot(limit=200)
            buttons = [e for e in elements if e.type == "ButtonControl" and e.name.lower().startswith("play")]
            best = next((e for e in buttons if q in e.name.lower()), buttons[0] if buttons else None)
            if best is None:
                return None
            d.click(best.id)
            return best.name

        pressed = await runner.run(press_play)
        if pressed:
            return {"playing": query, "pressed": pressed}
        return {"searched": query, "note": "Search is open but I couldn't find a Play button. Try vision_click."}

    return True
