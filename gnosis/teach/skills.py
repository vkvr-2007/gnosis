"""Saved skills: a named list of tool calls with {placeholders}, kept as readable SKILL.md files.

A skill is not code. Replaying it runs the same tools through the same policy gate as any request,
so a skill can never do more than you could ask Gnosis to do directly.
"""

from __future__ import annotations

import json
import re
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import yaml

_NAME = re.compile(r"^[a-z0-9][a-z0-9-]{0,48}$")
_PLACEHOLDER = re.compile(r"\{([a-z_][a-z0-9_]*)\}")
_JSON_BLOCK = re.compile(r"```json\n(.*?)\n```", re.S)
# Skills may not save or run skills, or change what Gnosis is allowed to do.
NOT_IN_SKILLS = {"save_skill", "run_skill", "delete_skill", "teach_start", "teach_stop", "edit_policy"}


class SkillError(ValueError):
    pass


@dataclass
class Skill:
    name: str
    description: str
    steps: list[dict[str, Any]]
    params: list[str] = field(default_factory=list)
    source: str = "task"  # taught | task
    created: float = field(default_factory=time.time)

    def summary(self) -> str:
        params = f" (needs: {', '.join(self.params)})" if self.params else ""
        return f"{self.name}: {self.description}{params}"

    def filled(self, values: dict[str, Any]) -> list[dict[str, Any]]:
        """The steps with {placeholders} replaced by this run's values."""
        missing = [p for p in self.params if p not in values]
        if missing:
            raise SkillError(f"'{self.name}' needs: {', '.join(missing)}")

        def fill(v: Any) -> Any:
            if isinstance(v, str):
                return _PLACEHOLDER.sub(lambda m: str(values.get(m.group(1), m.group(0))), v)
            if isinstance(v, dict):
                return {k: fill(x) for k, x in v.items()}
            if isinstance(v, list):
                return [fill(x) for x in v]
            return v

        return [{"tool": s["tool"], "args": fill(s.get("args", {}))} for s in self.steps]

    def to_markdown(self) -> str:
        front = yaml.safe_dump({"name": self.name, "description": self.description, "params": self.params,
                                "source": self.source, "created": round(self.created)}, sort_keys=False)
        lines = [f"---\n{front}---", f"# {self.name}", "", self.description, "", "## Steps", ""]
        for i, s in enumerate(self.steps, 1):
            args = ", ".join(f"{k}={json.dumps(v, ensure_ascii=False)}" for k, v in s.get("args", {}).items())
            lines.append(f"{i}. `{s['tool']}` {args}")
        lines += ["", "```json", json.dumps({"steps": self.steps}, indent=2, ensure_ascii=False), "```", ""]
        return "\n".join(lines)

    @classmethod
    def from_markdown(cls, text: str) -> "Skill":
        _, front, body = text.split("---", 2)
        meta = yaml.safe_load(front) or {}
        match = _JSON_BLOCK.search(body)
        steps = json.loads(match.group(1))["steps"] if match else []
        return cls(meta["name"], meta.get("description", ""), steps, list(meta.get("params") or []),
                   meta.get("source", "task"), float(meta.get("created", 0)))


def validate(skill: Skill, known_tools: set[str]) -> None:
    if not _NAME.match(skill.name):
        raise SkillError("Skill names use lowercase letters, digits and dashes, e.g. 'monthly-report'")
    if not skill.steps:
        raise SkillError("A skill needs at least one step")
    used: set[str] = set()
    for i, step in enumerate(skill.steps, 1):
        tool = step.get("tool")
        if tool in NOT_IN_SKILLS:
            raise SkillError(f"Step {i}: skills can't use {tool}")
        if tool not in known_tools:
            raise SkillError(f"Step {i}: there's no tool called '{tool}'")
        if not isinstance(step.get("args", {}), dict):
            raise SkillError(f"Step {i}: args must be an object")
        used |= set(_PLACEHOLDER.findall(json.dumps(step.get("args", {}))))
    unknown = used - set(skill.params)
    if unknown:
        raise SkillError(f"Placeholders without a matching param: {', '.join(sorted(unknown))}")


class SkillStore:
    def __init__(self, root: Path):
        self.root = root
        root.mkdir(parents=True, exist_ok=True)

    def _file(self, name: str) -> Path:
        if not _NAME.match(name):
            raise SkillError(f"No skill called '{name}'")
        return self.root / name / "SKILL.md"

    def save(self, skill: Skill) -> Path:
        path = self._file(skill.name)
        path.parent.mkdir(exist_ok=True)
        path.write_text(skill.to_markdown(), encoding="utf-8")
        return path

    def get(self, name: str) -> Skill | None:
        path = self._file(name)
        return Skill.from_markdown(path.read_text(encoding="utf-8")) if path.exists() else None

    def all(self) -> list[Skill]:
        out = []
        for path in sorted(self.root.glob("*/SKILL.md")):
            try:
                out.append(Skill.from_markdown(path.read_text(encoding="utf-8")))
            except Exception:
                continue  # A hand-edited file that no longer parses is skipped, not fatal
        return out

    def delete(self, name: str) -> bool:
        path = self._file(name)
        if not path.exists():
            return False
        path.unlink()
        try:
            path.parent.rmdir()
        except OSError:
            pass
        return True
