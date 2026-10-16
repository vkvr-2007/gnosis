"""Wires the Gnosis components together."""

from __future__ import annotations

from dataclasses import dataclass

from gnosis.config import Settings
from gnosis.core.audit import AuditLog
from gnosis.core.events import EventBus
from gnosis.core.llm import LLMClient
from gnosis.core.model_router import ModelRouter
from gnosis.core.orchestrator import Orchestrator
from gnosis.core.policy import ApprovalManager, Policy
from gnosis.core.tools import ToolRegistry
from gnosis.memory.memory import Memory
from gnosis.memory.store import MemoryStore
from gnosis.skills.builtin import register_builtin
from gnosis.skills.memory_tools import register_memory_tools


@dataclass
class Gnosis:
    settings: Settings
    events: EventBus
    audit: AuditLog
    policy: Policy
    approvals: ApprovalManager
    tools: ToolRegistry
    llm: LLMClient
    memory: Memory
    orchestrator: Orchestrator


def build(settings: Settings, llm: LLMClient | None = None) -> Gnosis:
    events = EventBus()
    audit = AuditLog(settings.db_path)

    async def on_model_call(info: dict) -> None:
        audit.write("model_call", **info)
        await events.publish("model_call", **info)

    if llm is None:
        llm = LLMClient(ModelRouter(settings.models), listener=on_model_call)
    policy = Policy(settings.policy)
    approvals = ApprovalManager()
    private_tags = set(settings.models.get("routing", {}).get("private_tags", []))
    memory = Memory(MemoryStore(settings.db_path), llm, private_tags=private_tags)
    tools = ToolRegistry()
    register_builtin(tools)
    register_memory_tools(tools, memory)
    orchestrator = Orchestrator(llm, tools, policy, approvals, audit, events, memory=memory,
                                max_steps=settings.max_steps,
                                approval_timeout_s=settings.approval_timeout_s)
    return Gnosis(settings, events, audit, policy, approvals, tools, llm, memory, orchestrator)
