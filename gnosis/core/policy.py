"""The policy gate: every tool call is checked here before it runs."""

from __future__ import annotations

import asyncio
import os
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

ALLOW, ASK, DENY = "allow", "ask", "deny"

# Tools whose `path` argument is checked against the filesystem rules.
_READ_TOOLS = {"read_file", "list_dir"}
_WRITE_TOOLS = {"write_file", "delete_file", "move_file"}


@dataclass(frozen=True)
class Decision:
    action: str  # allow | ask | deny
    reason: str


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
        for name, action in self.tools.items():
            if action not in (ALLOW, ASK, DENY):
                raise ValueError(f"policy.yaml: tool '{name}' has invalid action '{action}'")

    def decide(self, tool: str, args: dict[str, Any] | None = None) -> Decision:
        args = args or {}
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
        return Decision(ASK, f"'{tool}' needs your approval")


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

    async def wait(self, approval: Approval, timeout: float) -> bool:
        try:
            return await asyncio.wait_for(asyncio.shield(approval.future), timeout)
        except asyncio.TimeoutError:
            return False
        finally:
            self.pending.pop(approval.id, None)
