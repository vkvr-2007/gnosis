"""Tools for teach mode and saved skills."""

from __future__ import annotations

import sys
from typing import Any

from gnosis.core.tools import ToolRegistry
from gnosis.teach.skills import NOT_IN_SKILLS, Skill, SkillError, SkillStore, validate

_STEP = {"type": "object", "properties": {"tool": {"type": "string"}, "args": {"type": "object"}},
         "required": ["tool"]}
_SKIP_IN_RECAP = NOT_IN_SKILLS | {"recent_actions", "list_skills", "list_tasks"}


def skills_context(store: SkillStore):
    """Puts the saved skills' names and descriptions in front of the model (the steps load only when run)."""
    def provide() -> str | None:
        skills = store.all()
        if not skills:
            return None
        lines = "\n".join(f"- {s.summary()}" for s in skills[:40])
        return f"Saved skills the owner taught you (run one with run_skill):\n{lines}"
    return provide


def register_teach_tools(registry: ToolRegistry, orchestrator: Any, store: SkillStore,
                         skip_apps: tuple[str, ...] | None = None) -> None:
    state: dict[str, Any] = {"recorder": None}

    @registry.tool("teach_start",
                   "Start watching the owner demonstrate a task on the laptop ('watch me', 'learn this'). "
                   "Clicks and typing are recorded until teach_stop; password fields are never recorded.")
    def teach_start() -> str:
        if sys.platform != "win32":
            return "Teach mode only works on Windows"
        if state["recorder"] is not None:
            return "I'm already watching. Say 'done' when you've finished."
        from gnosis.teach.recorder import DEFAULT_SKIP_APPS, Recorder

        recorder = Recorder(skip_apps or DEFAULT_SKIP_APPS)
        recorder.start()
        state["recorder"] = recorder
        return "Watching. Do the task once, then say 'done'."

    @registry.tool("teach_stop",
                   "Stop watching ('done', 'that's it') and get the recorded steps. Then show the owner the steps, "
                   "turn values that should change each time into {placeholders} with matching params, and call "
                   "save_skill.")
    def teach_stop() -> dict:
        recorder = state.pop("recorder", None)
        state["recorder"] = None
        if recorder is None:
            return {"error": "I wasn't watching. Say 'watch me' first."}
        from gnosis.teach.recorder import steps_from_trace

        steps, notes = steps_from_trace(recorder.stop())
        return {"steps": steps, "notes": notes, "source": "taught"}

    @registry.tool("recent_actions",
                   "The tool calls from the owner's previous request, for 'save what you just did as a skill'.")
    def recent_actions() -> dict:
        from gnosis.core.orchestrator import _CURRENT

        current = _CURRENT.get()
        session, this_id = (current[0].session, current[0].id) if current else ("default", None)
        task = orchestrator.previous_task(session, before=this_id)
        if task is None:
            return {"error": "There's no earlier request to learn from"}
        steps = [{"tool": c["tool"], "args": c["args"]} for c in task.calls
                 if c["ok"] and c["tool"] not in _SKIP_IN_RECAP]
        return {"request": task.text, "steps": steps}

    @registry.tool("save_skill",
                   "Save a reusable skill: a name, what it does, the params it takes, and the tool-call steps with "
                   "{param} placeholders where values change, e.g. type_text {\"text\": \"Report for {month}\"}. "
                   "The owner approves it before it's saved.",
                   {"type": "object", "properties": {
                       "name": {"type": "string", "description": "lowercase-with-dashes"},
                       "description": {"type": "string"},
                       "params": {"type": "array", "items": {"type": "string"}},
                       "steps": {"type": "array", "items": _STEP},
                       "source": {"type": "string", "enum": ["taught", "task"]}},
                    "required": ["name", "description", "steps"]})
    def save_skill(name: str, description: str, steps: list, params: list | None = None,
                   source: str = "task") -> dict:
        skill = Skill(name, description, [{"tool": s.get("tool"), "args": s.get("args") or {}} for s in steps],
                      list(params or []), source)
        try:
            validate(skill, set(registry.names()))
        except SkillError as e:
            return {"error": str(e)}
        path = store.save(skill)
        return {"saved": skill.summary(), "file": str(path)}

    @registry.tool("run_skill", "Run a saved skill with values for its params.",
                   {"type": "object", "properties": {
                       "name": {"type": "string"},
                       "params": {"type": "object", "description": "e.g. {\"month\": \"March\"}"}},
                    "required": ["name"]})
    async def run_skill(name: str, params: dict | None = None) -> dict:
        skill = store.get(name)
        if skill is None:
            return {"error": f"No skill called '{name}'", "skills": [s.name for s in store.all()]}
        try:
            validate(skill, set(registry.names()))  # The file may have been edited by hand
            steps = skill.filled(params or {})
        except SkillError as e:
            return {"error": str(e)}
        done = []
        for i, step in enumerate(steps, 1):
            ok, output = await orchestrator.run_step(step["tool"], step["args"])
            done.append(step["tool"])
            if not ok:
                return {"error": f"Step {i} ({step['tool']}) failed", "detail": output[:500], "done": done}
        return {"ran": name, "steps": len(steps)}

    @registry.tool("list_skills", "List the saved skills.")
    def list_skills() -> list[str]:
        return [s.summary() for s in store.all()]

    @registry.tool("delete_skill", "Delete a saved skill.",
                   {"type": "object", "properties": {"name": {"type": "string"}}, "required": ["name"]})
    def delete_skill(name: str) -> dict:
        try:
            return {"deleted": name} if store.delete(name) else {"error": f"No skill called '{name}'"}
        except SkillError as e:
            return {"error": str(e)}
