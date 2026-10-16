from fastapi.testclient import TestClient

from conftest import FakeLLM, reply
from gnosis.app import build
from gnosis.server.api import create_app


def test_health_chat_audit_and_dashboard(settings):
    g = build(settings, llm=FakeLLM([reply("Hello, I'm Gnosis.")]))
    client = TestClient(create_app(g))
    assert client.get("/api/health").json()["ok"] is True
    r = client.post("/api/chat", json={"text": "hi", "private": True})
    assert r.json() == {"answer": "Hello, I'm Gnosis."}
    assert "private" in g.llm.calls[0]["tags"]
    assert client.get("/api/audit").json()[0]["kind"] == "answer"
    assert "GNOSIS" in client.get("/").text
    assert client.post("/api/approvals/nope", json={"approved": True}).status_code == 404
