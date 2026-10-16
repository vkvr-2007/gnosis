import asyncio
import json
from types import SimpleNamespace

import pytest

from conftest import FakeLLM, reply, tool_call
from gnosis.app import build
from gnosis.core.tools import ToolRegistry
from gnosis.killswitch import parse_hotkey
from gnosis.skills.desktop import DesktopRunner, apps, register_desktop_tools
from gnosis.skills.desktop.uia import Element, collect, combo_to_sendkeys, escape_text
from gnosis.skills.desktop import vision


# ---- finding apps --------------------------------------------------------

def index(exists=lambda p: False):
    return apps.AppIndex([
        apps.AppEntry("Spotify", "uwp", "SpotifyAB.SpotifyMusic_zpdnekdrzrea0!Spotify"),
        apps.AppEntry("Spotify", "shortcut", r"C:\...\Spotify.lnk"),
        apps.AppEntry("Visual Studio Code", "shortcut", r"C:\...\Visual Studio Code.lnk"),
        apps.AppEntry("Calculator", "uwp", "Microsoft.WindowsCalculator_8wekyb3d8bbwe!App"),
        apps.AppEntry("Riot Client", "shortcut", r"C:\...\Riot Client.lnk"),
    ], exists=exists)


def test_app_matching():
    idx = index()
    assert idx.best("spotify").kind == "shortcut"  # A real shortcut beats the Store duplicate
    assert idx.best("vscode").name == "Visual Studio Code"
    assert idx.best("calculater").name == "Calculator"
    assert idx.best("photoshop") is None


def test_valorant_uses_riot_launcher_when_installed():
    idx = index(exists=lambda p: p == apps.RIOT[0])
    v = idx.best("valorant")
    assert v.kind == "special" and v.target == apps.RIOT[0]
    assert "--launch-product=valorant" in v.args
    assert index().best("valorant") is None  # Not installed


# ---- keyboard ------------------------------------------------------------

def test_key_combos_and_literal_text():
    assert combo_to_sendkeys("ctrl+shift+s") == "{Ctrl}{Shift}s"
    assert combo_to_sendkeys("ctrl+a delete") == "{Ctrl}a{Delete}"
    assert combo_to_sendkeys("alt+f4") == "{Alt}{F4}"
    with pytest.raises(ValueError):
        combo_to_sendkeys("ctrl+banana")
    assert escape_text("f(x) = {y}\n") == "f{(}x{)} = {{}y{}}{Enter}"


def test_hotkey_parsing():
    mods, vk = parse_hotkey("ctrl+alt+j")
    assert vk == ord("J") and mods & 0x0003 == 0x0003
    with pytest.raises(ValueError):
        parse_hotkey("j")


# ---- reading windows -----------------------------------------------------

class R:
    def __init__(self, l, t, r, b):
        self.left, self.top, self.right, self.bottom = l, t, r, b

    def width(self):
        return self.right - self.left

    def height(self):
        return self.bottom - self.top


def ctl(ctype, name, rect=(0, 0, 50, 20), offscreen=False, enabled=True, value=None):
    c = SimpleNamespace(ControlTypeName=ctype, Name=name, IsOffscreen=offscreen, IsEnabled=enabled,
                        BoundingRectangle=R(*rect))
    c.GetValuePattern = lambda: SimpleNamespace(Value=value or "")
    return c


def test_collect_keeps_visible_useful_controls():
    walk = [(ctl("WindowControl", "Gmail"), 0), (ctl("ButtonControl", "Send"), 1),
            (ctl("ButtonControl", "Hidden", offscreen=True), 1), (ctl("ButtonControl", "Off", enabled=False), 1),
            (ctl("ButtonControl", "Tiny", rect=(0, 0, 1, 1)), 1), (ctl("TextControl", ""), 1),
            (ctl("TextControl", "Inbox"), 1), (ctl("EditControl", "To", value="mom@example.com"), 1)]
    els = collect(walk)
    assert [e.line() for e in els] == ["[1] Button 'Send'", "[2] Text 'Inbox'", "[3] Edit 'To' = 'mom@example.com'"]


# ---- desktop tools with a fake desktop -----------------------------------

class FakeDesktop:
    def __init__(self):
        self.open = [{"title": "Spotify Premium", "app": "Spotify", "handle": 11},
                     {"title": "notes.txt - Notepad", "app": "notepad", "handle": 22}]
        self.closed, self.focused, self.clicked = [], [], []
        self.last = [Element(1, "ButtonControl", "Send", "", (0, 0, 10, 10)),
                     Element(2, "ButtonControl", "Attach", "", (0, 0, 10, 10))]

    def windows(self):
        return self.open

    def find_windows(self, q):
        return [w for w in self.open if q.lower() in (w["title"] + w["app"]).lower()]

    def close_window(self, h):
        self.closed.append(h)

    def focus_window(self, h):
        self.focused.append(h)

    def foreground(self):
        return {"title": "Gmail", "app": "chrome", "handle": 33, "control": None}

    def snapshot(self, limit=80):
        return self.foreground(), self.last

    def click(self, element_id, double=False):
        self.clicked.append(element_id)
        return f"Clicked [{element_id}]"


@pytest.fixture
def desk(monkeypatch):
    fake = FakeDesktop()
    launched, urls = [], []
    monkeypatch.setattr(apps, "launch", lambda e: launched.append(e.name))
    monkeypatch.setattr(apps, "open_url", lambda u: urls.append(u))
    reg = ToolRegistry()
    assert register_desktop_tools(reg, FakeLLM([]), runner=DesktopRunner(lambda: fake), index=index())
    return SimpleNamespace(fake=fake, reg=reg, launched=launched, urls=urls,
                           run=lambda tool, **kw: asyncio.run(reg.get(tool).run(**kw)))


def test_open_close_and_web_fallback(desk):
    assert desk.run("open_app", name="spotify") == {"opened": "Spotify", "window": "Spotify Premium"}
    assert desk.launched == ["Spotify"] and desk.fake.focused == [11]
    assert desk.run("open_app", name="whatsapp")["opened_website"] == "https://web.whatsapp.com"
    assert "closest" in desk.run("open_app", name="photoshop")
    assert desk.run("close_app", name="notepad") == {"closed": ["notes.txt - Notepad"]}
    assert desk.fake.closed == [22]


def test_risky_click_escalates(desk):
    desk.run("look_at_window")
    click = desk.reg.get("click")
    assert "Send" in click.escalate({"element_id": 1})
    assert click.escalate({"element_id": 2}) is None


def test_click_on_send_waits_for_approval(settings, monkeypatch):
    fake = FakeDesktop()
    g = build(settings, llm=FakeLLM([reply(calls=[tool_call("click", {"element_id": 1})]), reply("Not sent.")]))
    register_desktop_tools(g.tools, g.llm, runner=DesktopRunner(lambda: fake), index=index())
    asyncio.run(g.tools.get("look_at_window").run())

    async def go():
        q = g.events.subscribe()

        async def decline():
            while True:
                ev = await q.get()
                if ev["type"] == "approval_needed":
                    g.approvals.resolve(ev["approval_id"], False)
        t = asyncio.create_task(decline())
        try:
            return await g.orchestrator.handle("send the email")
        finally:
            t.cancel()

    assert asyncio.run(go()) == "Not sent."
    assert fake.clicked == []


# ---- ask once per app ----------------------------------------------------

def test_ask_once_is_remembered_per_scope(settings):
    shots = []
    g = build(settings, llm=FakeLLM([
        reply(calls=[tool_call("look_at_screen", {"question": "q"})]), reply("one"),
        reply(calls=[tool_call("look_at_screen", {"question": "q"})]), reply("two"),
    ]))
    app = {"name": "chrome"}
    g.tools.tool("look_at_screen", "shot", {"type": "object", "properties": {"question": {"type": "string"}}},
                 approval_scope=lambda a: app["name"])(lambda question: shots.append(question) or "seen")
    asked = []

    async def go():
        q = g.events.subscribe()

        async def approve():
            while True:
                ev = await q.get()
                if ev["type"] == "approval_needed":
                    asked.append(ev["reason"])
                    g.approvals.resolve(ev["approval_id"], True)
        t = asyncio.create_task(approve())
        try:
            await g.orchestrator.handle("what's on screen")
            await g.orchestrator.handle("and now")
        finally:
            t.cancel()

    asyncio.run(go())
    assert len(asked) == 1 and "chrome" in asked[0] and len(shots) == 2
    assert json.loads((settings.data_dir / "grants.json").read_text()) == ["look_at_screen::chrome"]


# ---- kill switch ---------------------------------------------------------

def test_kill_switch_stops_running_task(settings):
    g = build(settings, llm=FakeLLM([reply(calls=[tool_call("slow", {})]), reply("never")]))
    g.tools.tool("slow", "takes ages")(lambda: asyncio.sleep(30))
    stopped_speech = []
    g.on_stop.append(lambda: stopped_speech.append(True))

    async def go():
        task = asyncio.create_task(g.orchestrator.handle("do the slow thing"))
        await asyncio.sleep(0.05)
        assert await g.stop_all() == 1
        return await task

    assert asyncio.run(go()) == "Stopped."
    assert stopped_speech == [True]
    assert g.audit.recent()[0]["kind"] in ("kill_switch", "stopped")


# ---- screenshot fallback -------------------------------------------------

def test_grid_marks_draw_and_pick():
    from PIL import Image

    marks = vision.grid_marks((100, 50), (1200, 800), cols=12, rows=8)
    assert len(marks) == 96 and marks[0].rect == (100, 50, 200, 150) and marks[-1].rect[2:] == (1300, 850)
    img = Image.new("RGB", (2560, 1600))
    out = vision.draw_marks(img, (0, 0), vision.grid_marks((0, 0), img.size))
    assert out.width == vision.MAX_WIDTH
    assert vision.parse_mark("Box 7.", 96) == 7 and vision.parse_mark("0", 96) is None
    llm = FakeLLM([reply("3")])
    assert asyncio.run(vision.pick_mark(llm, out, marks, "the play button", set())).id == 3
    assert llm.calls[0]["role"] == "vision"
