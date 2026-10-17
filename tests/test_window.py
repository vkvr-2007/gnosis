import socket
import threading
import time
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient

from conftest import FakeLLM, reply
from gnosis.app import build
from gnosis.server.api import create_app
from gnosis.window import single
from gnosis.window.shell import Shell


def free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def test_a_second_copy_brings_the_first_forward():
    port, shown = free_port(), threading.Event()
    first = single.claim(shown.set, port=port)
    try:
        assert first is not None
        assert single.claim(lambda: None, port=port) is None
        assert shown.wait(3)
    finally:
        first.close()
    time.sleep(0.1)
    again = single.claim(lambda: None, port=port)  # Free again once the first copy quits
    assert again is not None
    again.close()


class FakeEvents:
    def __init__(self):
        self.closing = self

    def __iadd__(self, fn):
        self.handler = fn
        return self


class FakeWindow:
    def __init__(self):
        self.events = FakeEvents()
        self.calls = []

    def __getattr__(self, name):
        return lambda *a: self.calls.append((name, *a))


class FakeWebview:
    def __init__(self):
        self.window = FakeWindow()

    def create_window(self, title, url, **kw):
        self.url = url
        return self.window

    def start(self, func, **kw):
        func()


class FakeTray:
    SEPARATOR = object()

    class Menu(tuple):
        SEPARATOR = object()

        def __new__(cls, *items):
            return tuple.__new__(cls, items)

    @staticmethod
    def MenuItem(text, action, default=False):
        return SimpleNamespace(text=text, action=action)

    class Icon:
        def __init__(self, name, image, title, menu):
            self.menu, self.stopped = menu, False

        def run_detached(self):
            pass

        def stop(self):
            self.stopped = True


def make_shell(server=None):
    pytest.importorskip("PIL")
    web = FakeWebview()
    shell = Shell("http://127.0.0.1:1", server, webview=web, tray=FakeTray)
    shell.run()
    return shell, web.window


def test_closing_the_window_hides_it_to_the_tray():
    shell, window = make_shell()
    assert window.events.handler() is False  # The close is cancelled...
    assert window.calls == [("hide",)]       # ...and the window hidden
    assert [i.text for i in shell.tray.menu if hasattr(i, "text")] == [
        "Open Gnosis", "Diagnostics", "Stop everything", "Quit Gnosis"]


def test_quit_from_the_tray_really_closes_and_stops_the_server():
    server = SimpleNamespace(stopped=False)
    server.stop = lambda: setattr(server, "stopped", True)
    shell, window = make_shell(server)
    quit_item = [i for i in shell.tray.menu if getattr(i, "text", "") == "Quit Gnosis"][0]
    quit_item.action()
    assert shell.tray.stopped and server.stopped and ("destroy",) in window.calls
    assert window.events.handler() is True  # The close now goes ahead


def test_diagnostics_from_the_tray_opens_the_tab():
    shell, window = make_shell()
    [i for i in shell.tray.menu if getattr(i, "text", "") == "Diagnostics"][0].action()
    assert window.calls[0] == ("show",) and "data-view=diag" in window.calls[-1][1]


def test_diagnostics_report_never_contains_a_key(settings, monkeypatch):
    monkeypatch.setenv("NEBIUS_API_KEY", "secret-value-123")
    g = build(settings, llm=FakeLLM([reply("Hello.")]))
    client = TestClient(create_app(g))
    client.post("/api/chat", json={"text": "hi"})
    g.audit.write("error", where="chat", error="something broke")
    r = client.get("/api/diagnostics")
    assert r.status_code == 200
    d = r.json()
    assert "secret-value-123" not in r.text
    assert {"name": "NEBIUS_API_KEY", "set": True} in d["keys"]
    assert d["errors"][0]["error"] == "something broke"
    local = [p for p in d["providers"] if p["local"]]
    assert local and all(isinstance(p["reachable"], bool) for p in local)
    assert d["voice"] == "off" and d["gnosis"]["data_dir"] == str(settings.data_dir)
