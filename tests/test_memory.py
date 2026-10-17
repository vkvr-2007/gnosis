import asyncio

import pytest
from fastapi.testclient import TestClient

from conftest import FakeLLM, reply, tool_call
from gnosis.app import build
from gnosis.memory.memory import Memory
from gnosis.memory.store import OWNER, MemoryStore
from gnosis.server.api import create_app


@pytest.fixture
def store(tmp_path):
    return MemoryStore(tmp_path / "m.db")


def test_upsert_replaces_value_and_respects_pins(store):
    f, changed = store.upsert_fact("me", "Prefers Language", "Python")
    assert changed and f.subject == OWNER and f.predicate == "prefers_language"
    f2, changed = store.upsert_fact("owner", "prefers_language", "TypeScript")
    assert changed and f2.id == f.id and f2.value == "TypeScript"
    store.update_fact(f.id, pinned=True)
    _, changed = store.upsert_fact("owner", "prefers_language", "Go")  # Extraction can't overwrite a pin
    assert not changed and store.get_fact(f.id).value == "TypeScript"
    _, changed = store.upsert_fact("owner", "prefers_language", "Rust", source="explicit")
    assert changed and store.get_fact(f.id).value == "Rust"


def test_forget_removes_fact_from_search_and_vectors(store):
    f, _ = store.upsert_fact("owner", "favourite_song", "Madhuvarame")
    store.set_vector("fact", f.id, [1.0, 0.0])
    assert store.search_text("fact", "madhuvarame")
    assert store.delete_fact(f.id)
    assert store.search_text("fact", "madhuvarame") == []
    assert store.search_vector("fact", [1.0, 0.0]) == []


def test_search_handles_punctuation_and_stemming(store):
    store.upsert_fact("owner", "prefers_language", "TypeScript")
    assert store.search_text("fact", 'what language do I prefer?? "quotes" (and) OR') != []
    assert store.search_text("fact", "!!!") == []


def recall(memory, query, **kw):
    return asyncio.run(memory.recall(query, **kw))


def test_recall_keyword_and_sensitive_filter(store):
    m = Memory(store, FakeLLM([]))
    store.upsert_fact("owner", "prefers_language", "TypeScript")
    store.upsert_fact("Mom", "phone_number", "+91 98450 00000", sensitive=True)
    store.upsert_fact("owner", "favourite_food", "dosa")
    got = recall(m, "start a project in my preferred language")
    assert [f.value for f in got.facts] == ["TypeScript"]
    assert recall(m, "call mom phone").facts == []
    assert recall(m, "call mom phone", include_sensitive=True).facts[0].subject == "Mom"


def test_recall_uses_vectors_when_embedder_runs(store):
    concepts = {"code": ["typescript", "coding", "program"], "food": ["dosa", "hungry", "eat"]}

    def embed(text):
        t = text.lower()
        return [float(any(w in t for w in words)) for words in concepts.values()] + [0.01]

    m = Memory(store, FakeLLM([], embeddings=embed))
    store.upsert_fact("owner", "prefers_language", "TypeScript")
    store.upsert_fact("owner", "favourite_food", "dosa")
    got = recall(m, "I'm hungry")  # No shared keywords: only the vector search can find this.
    assert [f.value for f in got.facts] == ["dosa"]


def test_pinned_facts_always_recalled(store):
    m = Memory(store, FakeLLM([]))
    f, _ = store.upsert_fact("owner", "name", "Vaarsh")
    store.update_fact(f.id, pinned=True)
    assert recall(m, "open spotify").facts[0].value == "Vaarsh"


def test_learn_saves_episode_and_confident_facts(store):
    llm = FakeLLM([], facts=[
        {"subject": "owner", "predicate": "prefers_language", "value": "TypeScript", "confidence": 0.9},
        {"subject": "owner", "predicate": "mood", "value": "tired", "confidence": 0.3},
        {"subject": "owner"},  # Malformed entries are skipped.
    ])
    m = Memory(store, llm, private_tags={"private"})
    saved = asyncio.run(m.learn("I prefer TypeScript", "Noted.", "t1", {"private"}))
    assert [f.value for f in saved] == ["TypeScript"]
    assert store.episodes()[0].request == "I prefer TypeScript"
    assert llm.extraction_calls[0]["tags"] == {"private"}  # Private chats are learned from locally.


def test_graph_links_people(store):
    m = Memory(store, FakeLLM([]))
    store.upsert_fact("owner", "mother_name", "Lakshmi")
    store.upsert_fact("Lakshmi", "lives_in", "Hyderabad")
    g = m.graph()
    ids = {n["id"] for n in g["nodes"]}
    assert {"s:owner", "s:Lakshmi"} <= ids
    mother = next(n["id"] for n in g["nodes"] if n.get("label", "").startswith("mother name"))
    assert {"from": mother, "to": "s:Lakshmi"} in g["edges"]


def test_agent_recalls_memory_in_later_request(settings):
    llm = FakeLLM([reply("Got it."), reply("Starting a TypeScript project.")],
                  facts=[{"subject": "owner", "predicate": "prefers_language", "value": "TypeScript"}])
    g = build(settings, llm=llm)

    async def go():
        await g.orchestrator.handle("Remember I prefer TypeScript")
        await g.memory.drain()
        return await g.orchestrator.handle("start a new API project in my preferred language")

    assert asyncio.run(go()) == "Starting a TypeScript project."
    system_msgs = [m["content"] for m in llm.calls[1]["messages"] if m["role"] == "system"]
    assert any("TypeScript" in m for m in system_msgs)


def test_remember_and_forget_tools(settings):
    g = build(settings, llm=FakeLLM([
        reply(calls=[tool_call("remember", {"subject": "owner", "predicate": "wake_time", "value": "7am"})]),
        reply("Saved."),
        reply(calls=[tool_call("forget", {"fact_id": 1})]),
        reply("Forgotten."),
    ]))

    async def go():
        await g.orchestrator.handle("remember I wake at 7am")
        assert g.memory.store.get_fact(1).value == "7am"
        await g.orchestrator.handle("forget that")
        await g.memory.drain()

    asyncio.run(go())
    assert g.memory.store.get_fact(1) is None


def test_memory_api(settings):
    g = build(settings, llm=FakeLLM([]))
    c = TestClient(create_app(g))
    fact = c.post("/api/memory/facts", json={"subject": "owner", "predicate": "city", "value": "Hyderabad"}).json()
    assert c.patch(f"/api/memory/facts/{fact['id']}", json={"pinned": True}).json()["pinned"] == 1
    assert c.get("/api/memory").json()["facts"][0]["value"] == "Hyderabad"
    assert len(c.get("/api/memory/graph").json()["nodes"]) == 2
    assert c.delete(f"/api/memory/facts/{fact['id']}").json() == {"ok": True}
    assert c.delete(f"/api/memory/facts/{fact['id']}").status_code == 404
    assert c.get("/api/audit").json()[0]["kind"] == "memory_edit"


def test_memory_ids_never_reach_the_owner(settings):
    from conftest import FakeLLM, reply
    from gnosis.app import build

    g = build(settings, llm=FakeLLM([reply("You prefer TypeScript. [#1] [#12]")]))
    assert asyncio.run(g.orchestrator.handle("which language do I like?")) == "You prefer TypeScript."
