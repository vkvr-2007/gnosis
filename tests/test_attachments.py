import asyncio
import io

import pytest
from fastapi.testclient import TestClient
from PIL import Image

from conftest import FakeLLM, reply, tool_call
from gnosis.app import build
from gnosis.attachments import AttachmentError, Inbox
from gnosis.server.api import create_app


def _png() -> bytes:
    buf = io.BytesIO()
    Image.new("RGB", (40, 30), (200, 30, 30)).save(buf, format="PNG")
    return buf.getvalue()


def test_inbox_sorts_text_images_and_the_rest(tmp_path):
    inbox = Inbox(tmp_path)
    note = inbox.save("../../notes.md", b"# Groceries\nmilk")
    assert note.kind == "text" and note.name == "notes.md" and note.path.parent.parent == tmp_path
    assert inbox.save("cam.jpg", b"\xff\xd8 not really").kind == "image"
    blob = inbox.save("tool.exe", b"MZ\x00\x00")
    assert blob.kind == "other"
    text = inbox.describe([note.id, blob.id])
    assert '[Attached file "notes.md". Its full text is below; no need to open it.]\n# Groceries\nmilk' in text
    assert "can't read it" in text
    for bad in ("../etc", "", "x" * 12):
        with pytest.raises(AttachmentError):
            inbox.get(bad)
    with pytest.raises(AttachmentError, match="empty"):
        inbox.save("a.txt", b"")


def test_attached_photo_is_seen_through_the_vision_model(settings):
    g = build(settings, llm=FakeLLM([]))
    client = TestClient(create_app(g))
    up = client.post("/api/files?name=camera-1012.jpg", content=_png()).json()
    assert up["kind"] == "image"
    g.llm.script += [reply(calls=[tool_call("look_at_image", {"file_id": up["id"], "question": "What colour?"})]),
                     reply("A red square."),  # The vision model's answer
                     reply("It's a red square.")]
    r = client.post("/api/chat", json={"text": "what's this?", "files": [up["id"]]})
    assert r.json()["answer"] == "It's a red square."
    asked = g.llm.calls[0]["messages"][-1]["content"]
    assert f"id {up['id']}. Use look_at_image" in asked
    vision = g.llm.calls[1]
    assert vision["role"] == "vision"
    parts = vision["messages"][0]["content"]
    assert parts[0]["text"] == "What colour?" and parts[1]["image_url"]["url"].startswith("data:image/jpeg;base64,")


def test_text_file_goes_into_the_request_and_bad_ids_are_refused(settings):
    g = build(settings, llm=FakeLLM([reply("Three items.")]))
    client = TestClient(create_app(g))
    up = client.post("/api/files?name=list.txt", content=b"milk\neggs\ncoffee").json()
    assert client.post("/api/chat", json={"text": "how many items?", "files": [up["id"]]}).json()["answer"] \
        == "Three items."
    assert "milk\neggs\ncoffee" in g.llm.calls[0]["messages"][-1]["content"]
    assert client.post("/api/chat", json={"text": "x", "files": ["nope"]}).status_code == 400


def test_camera_asks_first_and_only_exists_on_the_laptop(settings, monkeypatch):
    g = build(settings, llm=FakeLLM([]))
    assert "look_through_camera" not in g.tools.names()  # Not on Linux or in the hosted demo

    from gnosis.skills import vision_tools

    monkeypatch.setattr(vision_tools, "_camera_photo", lambda device=0: Image.new("RGB", (8, 8)))
    g.tools._tools.pop("look_at_image")  # Registered again below, this time with the camera
    vision_tools.register_vision_tools(g.tools, g.llm, g.inbox, camera=True)
    assert g.policy.decide("look_through_camera", {}).action == "ask"
    g.llm.script += [reply(calls=[tool_call("look_through_camera", {"question": "What am I holding?"})]),
                     reply("A mug.")]

    async def run():
        q = g.events.subscribe()

        async def deny():
            while True:
                ev = await q.get()
                if ev["type"] == "approval_needed":
                    g.approvals.resolve(ev["approval_id"], False)
        t = asyncio.create_task(deny())
        try:
            return await g.orchestrator.handle("what am I holding?")
        finally:
            t.cancel()
    asyncio.run(run())
    assert all(c["role"] != "vision" for c in g.llm.calls)  # Denied, so no photo was sent
