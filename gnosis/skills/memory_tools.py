"""Tools that let Gnosis remember, look up and forget facts when you ask it to."""

from __future__ import annotations

from gnosis.core.orchestrator import current_tags
from gnosis.core.tools import ToolRegistry
from gnosis.memory.memory import Memory


def register_memory_tools(registry: ToolRegistry, memory: Memory) -> None:
    @registry.tool(
        "remember",
        "Save a durable fact the owner asked you to remember, or that they clearly want kept. "
        "A new value for the same subject and predicate replaces the old one.",
        {
            "type": "object",
            "properties": {
                "subject": {"type": "string", "description": "'owner' for the owner, or a person/thing's name"},
                "predicate": {"type": "string", "description": "Short snake_case relation, e.g. prefers_language"},
                "value": {"type": "string"},
                "sensitive": {"type": "boolean", "description": "Health, money, phone numbers, addresses, IDs"},
            },
            "required": ["subject", "predicate", "value"],
        },
    )
    def remember(subject: str, predicate: str, value: str, sensitive: bool = False) -> dict:
        fact = memory.remember(subject, predicate, value, sensitive)
        return {"saved": fact.text, "id": fact.id}

    @registry.tool(
        "search_memory",
        "Look up what you remember about something. Returns facts with their ids.",
        {"type": "object", "properties": {"query": {"type": "string"}}, "required": ["query"]},
    )
    async def search_memory(query: str) -> dict:
        # Everyday facts may go to the cloud model, as they already do in the recalled context. Sensitive
        # ones (health, money, addresses, IDs) only come back when the task is already on the laptop.
        private = bool(current_tags() & memory.private_tags)
        recalled = await memory.recall(query, include_sensitive=private)
        out: dict = {"facts": [{"id": f.id, "fact": f.text} for f in recalled.facts]}
        if not private:
            held = await memory.recall(query, include_sensitive=True)
            hidden = len({f.id for f in held.facts} - {f.id for f in recalled.facts})
            if hidden:
                out["note"] = (f"{hidden} sensitive fact(s) also match. They're only shown in private mode, "
                               "which keeps the conversation on the laptop.")
        return out

    @registry.tool(
        "forget",
        "Permanently delete a remembered fact by its id, when the owner asks you to forget it.",
        {"type": "object", "properties": {"fact_id": {"type": "integer"}}, "required": ["fact_id"]},
    )
    def forget(fact_id: int) -> dict:
        fact = memory.store.get_fact(int(fact_id))
        if fact is None:
            return {"error": f"No fact with id {fact_id}"}
        memory.store.delete_fact(fact.id)
        return {"forgotten": fact.text}
