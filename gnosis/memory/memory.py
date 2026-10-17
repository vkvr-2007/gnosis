"""Memory service: recall what's relevant before a task, learn new facts after it."""

from __future__ import annotations

import asyncio
import json
import re
from dataclasses import dataclass, field
from typing import Any

from gnosis.memory.store import OWNER, Episode, Fact, MemoryStore

_EXTRACT_PROMPT = """You maintain the long-term memory of a personal assistant.
From the exchange below, extract durable facts worth remembering about the owner and the people,
projects, places and preferences in their life. Skip small talk, one-off requests and anything
already obvious from the request itself.

Return only JSON: {"facts": [{"subject": "...", "predicate": "...", "value": "...",
"sensitive": false, "confidence": 0.0-1.0}]}
- subject is "owner" for the owner, otherwise the person or thing's name.
- predicate is short snake_case, such as prefers_language, works_on, mother_name, phone_number.
- sensitive is true for health, money, passwords, exact addresses, phone numbers and IDs.
Return {"facts": []} if there is nothing worth keeping."""

_JSON_RE = re.compile(r"\{[\s\S]*\}")


@dataclass
class Recall:
    facts: list[Fact] = field(default_factory=list)
    episodes: list[Episode] = field(default_factory=list)

    @property
    def has_sensitive(self) -> bool:
        return any(f.sensitive for f in self.facts)

    def as_context(self, budget_chars: int = 2500) -> str | None:
        lines: list[str] = []
        if self.facts:
            lines.append("What you remember about the owner ([#id] is for the forget tool; never show it to the owner):")
            lines += [f"- [#{f.id}] {f.text}" for f in self.facts]
        if self.episodes:
            lines.append("Related past tasks:")
            lines += [f"- {e.request} -> {e.summary}" for e in self.episodes]
        text, used = [], 0
        for line in lines:
            if used + len(line) > budget_chars:
                break
            text.append(line)
            used += len(line) + 1
        return "\n".join(text) or None


def _normalize(scores: list[tuple[int, float]]) -> dict[int, float]:
    if not scores:
        return {}
    top = max(s for _, s in scores) or 1.0
    return {i: max(s, 0.0) / top for i, s in scores}


class Memory:
    def __init__(self, store: MemoryStore, llm: Any, *, private_tags: set[str] = frozenset(),
                 max_facts: int = 8, max_episodes: int = 3, min_confidence: float = 0.6):
        self.store = store
        self.private_tags = set(private_tags)
        self.llm = llm
        self.max_facts = max_facts
        self.max_episodes = max_episodes
        self.min_confidence = min_confidence
        self._background: set[asyncio.Task] = set()

    # ---- recall ------------------------------------------------------------

    async def _index_missing(self) -> bool:
        """Embeds any facts and episodes that don't have vectors yet. False if no embedder is running."""
        for kind in ("fact", "episode"):
            missing = self.store.missing_vectors(kind)
            if not missing:
                continue
            vectors = await self.llm.embed([t for _, t in missing])
            if vectors is None:
                return False
            for (ref_id, _), vec in zip(missing, vectors):
                self.store.set_vector(kind, ref_id, vec)
        return True

    async def _rank(self, kind: str, query: str, query_vec: list[float] | None, limit: int) -> list[int]:
        text = _normalize(self.store.search_text(kind, query, limit=20))
        vec = _normalize(self.store.search_vector(kind, query_vec, limit=20)) if query_vec else {}
        if vec:
            # Vector matches need to be fairly close to count; keyword hits always count.
            vec = {i: s for i, s in vec.items() if s > 0.5}
        combined = {i: 0.5 * text.get(i, 0.0) + 0.5 * vec.get(i, 0.0) if vec else text.get(i, 0.0)
                    for i in set(text) | set(vec)}
        return [i for i, _ in sorted(combined.items(), key=lambda x: x[1], reverse=True)[:limit]]

    async def recall(self, query: str, include_sensitive: bool = False) -> Recall:
        query_vec = None
        if await self._index_missing():
            vecs = await self.llm.embed([query])
            query_vec = vecs[0] if vecs else None

        pinned = [f for f in self.store.facts(include_sensitive) if f.pinned][: self.max_facts]
        fact_ids = await self._rank("fact", query, query_vec, self.max_facts * 2)
        facts = {f.id: f for f in pinned}
        for fid in fact_ids:
            fact = self.store.get_fact(fid)
            if fact and (include_sensitive or not fact.sensitive):
                facts.setdefault(fid, fact)
            if len(facts) >= self.max_facts:
                break
        episode_ids = await self._rank("episode", query, query_vec, self.max_episodes)
        episodes = [e for e in (self.store.get_episode(i) for i in episode_ids) if e]
        return Recall(list(facts.values()), episodes)

    # ---- learning ----------------------------------------------------------

    def remember(self, subject: str, predicate: str, value: str, sensitive: bool = False) -> Fact:
        fact, _ = self.store.upsert_fact(subject or OWNER, predicate, value, source="explicit",
                                         confidence=1.0, sensitive=sensitive)
        return fact

    async def learn(self, request: str, answer: str, task_id: str, tags: set[str]) -> list[Fact]:
        """Saves the episode and extracts durable facts from it."""
        episode = self.store.add_episode(request, answer[:500], task_id)
        messages = [
            {"role": "system", "content": _EXTRACT_PROMPT},
            {"role": "user", "content": f"Owner: {request}\nAssistant: {answer}"},
        ]
        try:
            result = await self.llm.chat("fast", messages, tags=tags, temperature=0)
        except Exception:
            return []  # Extraction is best effort; the episode is already saved.
        saved = []
        for raw in _parse_facts(result.message.content or ""):
            try:
                if float(raw.get("confidence", 0.8)) < self.min_confidence:
                    continue
                fact, changed = self.store.upsert_fact(
                    str(raw["subject"]), str(raw["predicate"]), str(raw["value"]),
                    source="conversation", confidence=float(raw.get("confidence", 0.8)),
                    sensitive=bool(raw.get("sensitive", False)), episode_id=episode.id)
            except (KeyError, TypeError, ValueError):
                continue
            if changed:
                saved.append(fact)
        return saved

    def learn_in_background(self, request: str, answer: str, task_id: str, tags: set[str]) -> asyncio.Task:
        task = asyncio.create_task(self.learn(request, answer, task_id, tags))
        self._background.add(task)
        task.add_done_callback(self._background.discard)
        return task

    async def drain(self) -> None:
        """Waits for background learning to finish (used on shutdown and in tests)."""
        if self._background:
            await asyncio.gather(*self._background, return_exceptions=True)

    # ---- memory map --------------------------------------------------------

    def graph(self) -> dict[str, list[dict[str, Any]]]:
        """Nodes and edges for the dashboard's memory map: the owner at the centre."""
        facts = [f for f in self.store.facts() if f.source != "phone"]  # Synced contacts would swamp the map
        subjects = {OWNER} | {f.subject for f in facts}
        by_lower = {s.lower(): s for s in subjects}
        nodes = [{"id": f"s:{s}", "label": "You" if s == OWNER else s, "kind": "subject"} for s in sorted(subjects)]
        edges = []
        for f in facts:
            nodes.append({"id": f"f:{f.id}", "label": f"{f.predicate.replace('_', ' ')}: {f.value}",
                          "kind": "fact", "fact_id": f.id, "pinned": f.pinned, "sensitive": f.sensitive})
            edges.append({"from": f"s:{f.subject}", "to": f"f:{f.id}"})
            linked = by_lower.get(f.value.lower())
            if linked and linked != f.subject:
                edges.append({"from": f"f:{f.id}", "to": f"s:{linked}"})
        return {"nodes": nodes, "edges": edges}


def _parse_facts(text: str) -> list[dict[str, Any]]:
    match = _JSON_RE.search(text)
    if not match:
        return []
    try:
        data = json.loads(match.group(0))
    except json.JSONDecodeError:
        return []
    facts = data.get("facts", []) if isinstance(data, dict) else []
    return [f for f in facts if isinstance(f, dict)]
