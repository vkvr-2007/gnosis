import asyncio

import pytest
from fastapi.testclient import TestClient

from conftest import FakeLLM, reply, tool_call
from gnosis.app import build
from gnosis.phone.adb import AdbError, Phone, parse_contacts, parse_notifications, parse_ui_dump
from gnosis.phone.devices import Devices, is_local_request
from gnosis.proactive import Notice, Notifier
from gnosis.core.audit import AuditLog
from gnosis.core.events import EventBus
from gnosis.server.api import create_app
from gnosis.skills.phone_tools import PHONE_NUMBER


# ---- who may talk to Gnosis ---------------------------------------------------

def test_only_the_laptops_own_browser_is_trusted():
    assert is_local_request("127.0.0.1", "127.0.0.1:8765", {})
    assert is_local_request("::1", "localhost:8765", {})
    assert not is_local_request("192.168.1.20", "192.168.1.5:8765", {})          # The phone on Wi-Fi
    assert not is_local_request("127.0.0.1", "127.0.0.1:8765", {"x-forwarded-for": "100.64.0.2"})  # tailscale serve
    assert not is_local_request("127.0.0.1", "evil.example:8765", {})            # DNS rebinding


def test_pairing_codes_are_single_use_and_expire(tmp_path):
    clock = [1000.0]
    devices = Devices(tmp_path / "d.db", clock=lambda: clock[0])
    code, _ = devices.new_pairing_code()
    device, token = devices.claim(code, "Pixel")
    assert devices.verify(token).name == "Pixel"
    assert devices.claim(code, "again") is None
    late, _ = devices.new_pairing_code()
    clock[0] += 301
    assert devices.claim(late, "late") is None
    assert devices.verify("made-up") is None
    devices.remove(device.id)
    assert devices.verify(token) is None


def test_phone_needs_a_token_and_dashboard_doesnt(settings):
    g = build(settings, llm=FakeLLM([]))
    laptop = TestClient(create_app(g))
    phone = TestClient(create_app(g), client=("192.168.1.20", 50000), base_url="http://192.168.1.5:8765")

    assert laptop.get("/api/tasks").status_code == 200
    assert phone.get("/api/tasks").status_code == 401
    assert phone.post("/api/phone/pair").status_code == 401  # Only the laptop can start pairing
    assert phone.get("/api/health").status_code == 200

    pairing = laptop.post("/api/phone/pair").json()
    assert "<svg" in pairing["qr_svg"] and "/phone/#pair=" in pairing["url"] and pairing["lan_only"]
    code = pairing["url"].split("pair=")[1]
    claimed = phone.post("/api/phone/claim", json={"code": code, "name": "Pixel"}).json()
    auth = {"Authorization": "Bearer " + claimed["token"]}
    assert phone.get("/api/tasks", headers=auth).status_code == 200
    assert phone.post("/api/phone/pair", headers=auth).status_code == 403  # Still laptop-only
    assert phone.post("/api/phone/claim", json={"code": code, "name": "x"}).status_code == 403

    with phone.websocket_connect(f"/ws?token={claimed['token']}") as ws:
        pass  # Accepted
    with pytest.raises(Exception):
        with phone.websocket_connect("/ws?token=wrong") as ws:
            ws.receive_json()

    assert [d["name"] for d in laptop.get("/api/phone/devices").json()] == ["Pixel"]
    assert "Gnosis" in phone.get("/phone/").text  # The phone app itself is public
    assert phone.get("/", follow_redirects=False).headers["location"] == "/phone/"
    assert "<html" in laptop.get("/").text.lower()


def test_public_url_and_cloud_config(monkeypatch, tmp_path):
    from gnosis.config import REPO_ROOT, load_settings

    monkeypatch.setenv("GNOSIS_PUBLIC_URL", "https://203-0-113-7.sslip.io")
    raw = (REPO_ROOT / "config" / "gnosis.cloud.yaml").read_text().replace("/data", str(tmp_path))
    (tmp_path / "cloud.yaml").write_text(raw)
    s = load_settings(tmp_path / "cloud.yaml")
    assert s.phone["url"] == "https://203-0-113-7.sslip.io" and s.desktop is False and s.host == "0.0.0.0"
    g = build(s, llm=FakeLLM([]))
    assert "send_sms" not in g.tools.names() and "code_run" in g.tools.names()
    url = TestClient(create_app(g)).post("/api/phone/pair").json()["url"]
    assert url.startswith("https://203-0-113-7.sslip.io/phone/#pair=")


def test_other_websites_cant_use_the_laptop_browser(settings):
    g = build(settings, llm=FakeLLM([]))
    laptop = TestClient(create_app(g))
    assert laptop.post("/api/stop", headers={"Origin": "https://evil.example"}).status_code == 401
    assert laptop.post("/api/stop", headers={"Origin": "http://testserver"}).status_code == 200


def test_notices_go_to_the_phone_when_away(tmp_path):
    pushed = []

    async def push(title, body):
        pushed.append(title)
        return 1

    idle = [0.0]
    n = Notifier(EventBus(), AuditLog(tmp_path / "a.db"), {"quiet_hours": None}, toast=lambda t, b: None,
                 busy=lambda: False, idle=lambda: idle[0])
    n.push = push
    assert asyncio.run(n.notify(Notice("Reminder", "stretch", "high"))) == ["toast", "speak"]
    idle[0] = 900
    assert asyncio.run(n.notify(Notice("Reminder", "call mom", "high"))) == ["toast", "speak", "phone"]
    assert asyncio.run(n.notify(Notice("Tip", "fyi", "low"))) == []  # Held for the briefing, not pushed
    assert pushed == ["Reminder"]


# ---- the Android phone over ADB ------------------------------------------------

class FakeAdb:
    def __init__(self):
        self.calls = []
        self.connected = True
        self.screen = """<?xml version='1.0'?><hierarchy><node text="" content-desc="Send" resource-id="com.whatsapp:id/send"
            bounds="[900,2100][1040,2200]"/><node text="Type a message" resource-id="x" bounds="[0,2100][880,2200]"/></hierarchy>"""

    def __call__(self, args, timeout):
        self.calls.append(args)
        if args[0] == "devices":
            return "List of devices attached\n192.168.1.20:41235\tdevice\n" if self.connected else "List of devices attached\n"
        if args[0] == "connect":
            raise AdbError("failed to connect")
        if args[0] == "shell" and args[1].startswith("cat /sdcard/gnosis_ui.xml"):
            return self.screen
        if args[0] == "shell" and args[1].startswith("content query"):
            return ("Row: 0 display_name=Amma, data1=+91 98765 43210\n"
                    "Row: 1 display_name=Rahul Sharma, data1=098765-11111\n"
                    "Row: 2 display_name=Rahul Verma, data1=+91 90000 22222\n")
        return ""

    def shells(self):
        return [a[1] for a in self.calls if a[0] == "shell"]


@pytest.fixture
def phone_g(settings, monkeypatch):
    import gnosis.phone.adb as adb_mod

    monkeypatch.setattr(adb_mod.time, "sleep", lambda s: None)
    fake = FakeAdb()

    def make(script):
        g = build(settings, llm=FakeLLM(script))
        g.phone._run = fake
        return g
    return make, fake


def run(g, text, approve=True):
    async def go():
        q = g.events.subscribe()

        async def answer():
            while True:
                ev = await q.get()
                if ev["type"] == "approval_needed":
                    g.approvals.resolve(ev["approval_id"], approve)
        t = asyncio.create_task(answer())
        try:
            return await g.orchestrator.handle(text)
        finally:
            t.cancel()
    return asyncio.run(go())


def test_sync_contacts_then_call_by_name(phone_g):
    make, fake = phone_g
    g = make([reply(calls=[tool_call("sync_contacts", {})]), reply("Synced 3 contacts."),
              reply(calls=[tool_call("call", {"who": "amma"})]), reply("Calling Amma.")])
    run(g, "sync my contacts")
    numbers = {f.subject: f.value for f in g.memory.store.facts() if f.predicate == PHONE_NUMBER}
    assert numbers == {"Amma": "+919876543210", "Rahul Sharma": "09876511111", "Rahul Verma": "+919000022222"}
    assert all(f.sensitive for f in g.memory.store.facts())
    assert g.memory.graph()["nodes"] == [{"id": "s:owner", "label": "You", "kind": "subject"}]  # Not on the map

    run(g, "call amma")
    assert "am start -a android.intent.action.CALL -d tel:+919876543210" in fake.shells()
    tool_result = g.llm.calls[-1]["messages"][-1]["content"]
    assert "Amma" in tool_result and "98765" not in tool_result  # The number isn't sent to the model


def test_call_asks_first_and_ambiguous_names_ask_which(phone_g):
    make, fake = phone_g
    g = make([reply(calls=[tool_call("call", {"who": "+91 98765 43210"})]), reply("Okay, I won't.")])
    run(g, "call that number", approve=False)
    assert not any("CALL" in s for s in fake.shells())

    g = make([reply(calls=[tool_call("sync_contacts", {})]), reply("ok"),
              reply(calls=[tool_call("send_whatsapp", {"to": "rahul", "text": "Running late"})]), reply("Which?")])
    run(g, "sync contacts")
    run(g, "whatsapp rahul I'm running late")
    assert "Rahul Sharma, Rahul Verma" in g.llm.calls[-1]["messages"][-1]["content"]


def test_whatsapp_opens_chat_and_taps_send(phone_g):
    make, fake = phone_g
    g = make([])
    phone = g.phone
    assert phone.send_whatsapp("+91 98765 43210", "I'll be late") == "Sent the WhatsApp message to +919876543210"
    assert any("https://wa.me/919876543210?text=I%27ll%20be%20late" in s for s in fake.shells())
    assert "input tap 970 2150" in fake.shells()


def test_phone_not_connected_explains_what_to_do(tmp_path):
    fake = FakeAdb()
    fake.connected = False
    phone = Phone(fake, tmp_path / "phone.json")
    with pytest.raises(AdbError, match="wireless debugging"):
        phone.call("12345")
    with pytest.raises(AdbError, match="isn't installed"):
        Phone(None).status()


def test_parsers():
    nodes = parse_ui_dump(FakeAdb().screen)
    assert nodes[0].center == (970, 2150) and nodes[0].desc == "Send"
    dump = """
  NotificationRecord(0x0a1b: pkg=com.whatsapp user=UserHandle{0} id=1 tag=null importance=4 key=0|com.whatsapp|1)
      extras={
        android.title=String (Mom)
        android.text=String (Did you eat?)
      }
  NotificationRecord(0x0c2d: pkg=android user=UserHandle{0} id=2)
        android.title=String (USB debugging connected)
"""
    assert parse_notifications(dump) == [{"app": "com.whatsapp", "title": "Mom", "text": "Did you eat?"}]
    assert parse_contacts("Row: 0 display_name=NULL, data1=123\nRow: 1 display_name=Dad, data1=not a number") == []
