"""Wires the Gnosis components together."""

from __future__ import annotations

import sys
from dataclasses import dataclass, field

from gnosis.config import Settings
from gnosis.core.audit import AuditLog
from gnosis.core.events import EventBus
from gnosis.core.llm import LLMClient
from gnosis.core.model_router import ModelRouter
from gnosis.core.orchestrator import Orchestrator
from gnosis.core.policy import ApprovalManager, Grants, Policy
from gnosis.core.tools import ToolRegistry
from gnosis.memory.memory import Memory
from gnosis.memory.store import MemoryStore
from gnosis.skills.builtin import register_builtin
from gnosis.skills.desktop import register_desktop_tools
from gnosis.skills.memory_tools import register_memory_tools
from gnosis.skills.task_tools import register_task_tools


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
    on_stop: list = field(default_factory=list)  # Extra things the kill switch stops, e.g. speech

    async def stop_all(self) -> int:
        """The kill switch: cancels running tasks, declines pending approvals and stops speaking."""
        stopped = self.orchestrator.cancel_all()
        self.approvals.reject_all()
        for fn in self.on_stop:
            fn()
        self.audit.write("kill_switch", tasks_stopped=stopped)
        await self.events.publish("stopped", tasks=stopped)
        return stopped


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
    if settings.desktop and sys.platform == "win32":
        register_desktop_tools(tools, llm)
    orchestrator = Orchestrator(llm, tools, policy, approvals, audit, events, memory=memory,
                                grants=Grants(settings.data_dir / "grants.json"),
                                max_steps=settings.max_steps,
                                approval_timeout_s=settings.approval_timeout_s,
                                max_parallel=settings.max_parallel)
    register_task_tools(tools, orchestrator)
    return Gnosis(settings, events, audit, policy, approvals, tools, llm, memory, orchestrator)
