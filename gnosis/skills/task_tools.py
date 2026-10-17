"""Tools for checking on and steering tasks that are running in parallel ("how's the website going?")."""

from __future__ import annotations

import time

from gnosis.core.tools import ToolRegistry

_TASK_ARG = {"type": "object",
             "properties": {"task": {"type": "string", "description": "The task's id, or words from its request"}},
             "required": ["task"]}


def register_task_tools(registry: ToolRegistry, orchestrator) -> None:
    def describe(t) -> dict:
        out = {"id": t.id, "request": t.text, "status": t.status, "doing": t.detail,
               "running_for_s": round((t.finished or time.time()) - t.created)}
        if t.answer:
            out["result"] = t.answer[:300]
        return out

    @registry.tool("list_tasks", "List the tasks Gnosis is working on in the background and how each is going.")
    def list_tasks() -> list[dict]:
        return [describe(t) for t in orchestrator.list_tasks()][-10:]

    def act(action: str, query: str) -> dict:
        t = orchestrator.find_task(query)
        if t is None:
            return {"error": f"No running task matches '{query}'"}
        ok = getattr(orchestrator, action)(t.id)
        return {action: ok, "task": t.text}

    @registry.tool("pause_task", "Pause a running background task between its steps.", _TASK_ARG)
    def pause_task(task: str) -> dict:
        return act("pause", task)

    @registry.tool("resume_task", "Resume a paused background task.", _TASK_ARG)
    def resume_task(task: str) -> dict:
        return act("resume", task)

    @registry.tool("cancel_task", "Stop a running background task.", _TASK_ARG)
    def cancel_task(task: str) -> dict:
        return act("cancel", task)
