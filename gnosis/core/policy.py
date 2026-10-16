"""The policy gate: every tool call is checked here before it runs."""

from __future__ import annotations

import asyncio
import json
import os
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

ALLOW, ASK, DENY = "allow", "ask", "deny"
ASK_ONCE = "ask_once"  # Ask the first time for each scope (e.g. each app), then remember the answer

# Tools whose `path` argument is checked against the filesystem rules.
_READ_TOOLS = {"read_file", "list_dir"}
_WRITE_TOOLS = {"write_file", "delete_file", "move_file"}


@dataclass(frozen=True)
class Decision:
    action: str  # allow | ask | deny
    reason: str
    once: bool = False  # An approval can be remembered for this tool and scope


def _norm(p: str | Path) -> str:
    return os.path.normcase(os.path.abspath(os.path.expanduser(str(p))))


def _under(path: str, roots: list[str]) -> bool:
    for root in roots:
        r = _norm(root)
        if path == r or path.startswith(r.rstrip(os.sep) + os.sep):
            return True
    return False


class Policy:
    def __init__(self, cfg: dict[str, Any]):
        self.default = cfg.get("default", ASK)
        self.tools: dict[str, str] = cfg.get("tools", {})
        fs = cfg.get("filesystem", {})
        self.read_roots: list[str] = fs.get("read", [])
        self.write_roots: list[str] = fs.get("write", [])
        self.deny_roots: list[str] = fs.get("deny", [])
        # Tools anyone may use by voice, even when voice ID doesn't recognise them as the owner.
        self.guest_tools: set[str] = set(cfg.get("guest_tools", []))
        for name, action in self.tools.items():
            if action not in (ALLOW, ASK, ASK_ONCE, DENY):
                raise ValueError(f"policy.yaml: tool '{name}' has invalid action '{action}'")

    def decide(self, tool: str, args: dict[str, Any] | None = None, owner: bool = True) -> Decision:
        args = args or {}
        if not owner and tool not in self.guest_tools:
            return Decision(DENY, "only the owner can ask for that, and I didn't recognise your voice")
        action = self.tools.get(tool, self.default)
        if action == DENY:
            return Decision(DENY, f"'{tool}' is never allowed by policy")

        path = args.get("path")
        if isinstance(path, str) and (tool in _READ_TOOLS or tool in _WRITE_TOOLS):
            p = _norm(path)
            if _under(p, self.deny_roots):
                return Decision(DENY, f"{path} is in a protected location")
            roots = self.write_roots if tool in _WRITE_TOOLS else self.read_roots + self.write_roots
            if not _under(p, roots):
                return Decision(ASK, f"{path} is outside the folders Gnosis may use")

        if action == ALLOW:
            return Decision(ALLOW, "allowed by policy")
        if action == ASK_ONCE:
            return Decision(ASK, f"'{tool}' needs your approval the first time", once=True)
        return Decision(ASK, f"'{tool}' needs your approval")


class Grants:
    """Remembered "ask once" approvals, saved so they survive restarts."""

    def __init__(self, path: Path | None = None):
        self.path = path
        self._grants: set[str] = set()
        if path and path.exists():
            try:
                self._grants = set(json.loads(path.read_text(encoding="utf-8")))
            except (ValueError, OSError):
                self._grants = set()

    @staticmethod
    def _key(tool: str, scope: str) -> str:
        return f"{tool}::{scope.lower()}"

    def has(self, tool: str, scope: str) -> bool:
        return self._key(tool, scope) in self._grants

    def add(self, tool: str, scope: str) -> None:
        self._grants.add(self._key(tool, scope))
        if self.path:
            self.path.write_text(json.dumps(sorted(self._grants)), encoding="utf-8")

    def revoke_all(self) -> None:
        self._grants.clear()
        if self.path and self.path.exists():
            self.path.unlink()


@dataclass
class Approval:
    id: str
    tool: str
    args: dict[str, Any]
    reason: str
    future: asyncio.Future = field(repr=False)


class ApprovalManager:
    """Holds pending "ask" decisions until the owner answers from any device."""

    def __init__(self) -> None:
        self.pending: dict[str, Approval] = {}

    def create(self, tool: str, args: dict[str, Any], reason: str) -> Approval:
        approval = Approval(uuid.uuid4().hex[:12], tool, args, reason,
                            asyncio.get_running_loop().create_future())
        self.pending[approval.id] = approval
        return approval

    def resolve(self, approval_id: str, approved: bool) -> bool:
        approval = self.pending.pop(approval_id, None)
        if approval is None or approval.future.done():
            return False
        approval.future.set_result(approved)
        return True

    def reject_all(self) -> int:
        ids = list(self.pending)
        for approval_id in ids:
            self.resolve(approval_id, False)
        return len(ids)

    async def wait(self, approval: Approval, timeout: float) -> bool:
        try:
            return await asyncio.wait_for(asyncio.shield(approval.future), timeout)
        except asyncio.TimeoutError:
            return False
        finally:
            self.pending.pop(approval.id, None)
