"""What the diagnostics panel shows: is each part of Gnosis working, and if not, why.

Never includes a key's value: only whether each key is set.
"""

from __future__ import annotations

import asyncio
import os
import platform
import socket
import statistics
import subprocess
import sys
import time
from typing import TYPE_CHECKING, Any
from urllib.parse import urlparse

from gnosis import __version__
from gnosis.config import REPO_ROOT

if TYPE_CHECKING:
    from gnosis.app import Gnosis

_STARTED = time.time()
_RECENT = 300  # Audit rows the panel looks back over


def _commit() -> str | None:
    try:
        out = subprocess.run(["git", "rev-parse", "--short", "HEAD"], cwd=REPO_ROOT, capture_output=True,
                             text=True, timeout=3)
        return out.stdout.strip() or None
    except (OSError, subprocess.SubprocessError):
        return None


def _reachable(base_url: str, timeout: float = 0.5) -> bool:
    """Can we open a connection to a local model server? (Cloud providers are judged by their last call.)"""
    url = urlparse(base_url)
    try:
        with socket.create_connection((url.hostname or "127.0.0.1", url.port or 80), timeout=timeout):
            return True
    except OSError:
        return False


def _calls(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    by_role: dict[str, list[dict[str, Any]]] = {}
    for r in rows:
        if r["kind"] == "model_call":
            by_role.setdefault(r.get("role", "?"), []).append(r)
    out = []
    for role, calls in sorted(by_role.items()):
        ms = [c["latency_ms"] for c in calls if isinstance(c.get("latency_ms"), (int, float))]
        out.append({"role": role, "calls": len(calls), "model": calls[0].get("model"),
                    "where": calls[0].get("where"), "last_ms": ms[0] if ms else None,
                    "median_ms": round(statistics.median(ms)) if ms else None, "last_ts": calls[0]["ts"]})
    return out


async def collect(g: "Gnosis") -> dict[str, Any]:
    models = g.settings.models
    providers: dict[str, Any] = models.get("providers", {})
    roles: dict[str, Any] = models.get("roles", {})

    keys = sorted({p["api_key_env"] for p in providers.values() if p.get("api_key_env")})
    if "elevenlabs" in (g.settings.voice.get("stt"), g.settings.voice.get("tts")):
        keys.append("ELEVENLABS_API_KEY")

    local = {name: p["base_url"] for name, p in providers.items() if p.get("on_device")}
    up = await asyncio.gather(*(asyncio.to_thread(_reachable, url) for url in local.values()))
    provider_rows = []
    for name, p in providers.items():
        key_env = p.get("api_key_env")
        provider_rows.append({
            "name": name, "url": p.get("base_url"), "local": bool(p.get("on_device")),
            "key": key_env, "key_set": bool(os.environ.get(key_env)) if key_env else None,
            "reachable": dict(zip(local, up)).get(name),
            "roles": [r for r, cfg in roles.items() if cfg.get("provider") == name],
        })

    rows = g.audit.recent(_RECENT)
    errors = [r for r in rows if r["kind"] in ("error", "voice_error")][:10]
    voice = g.events.last.get("voice_state")
    return {
        "gnosis": {"version": __version__, "commit": _commit(), "folder": str(REPO_ROOT),
                   "data_dir": str(g.settings.data_dir), "python": sys.version.split()[0],
                   "platform": platform.platform(), "uptime_s": round(time.time() - _STARTED),
                   "pid": os.getpid()},
        "online": g.llm.online,
        "keys": [{"name": k, "set": bool(os.environ.get(k))} for k in keys],
        "providers": provider_rows,
        "calls": _calls(rows),
        "voice": voice["state"] if voice else "off",
        "tools": len(g.tools.names()),
        "tasks": {"running": len(g.orchestrator.list_tasks(include_finished=False)),
                  "approvals_waiting": len(g.approvals.pending)},
        "claim_checks": sum(r["kind"] == "claim_check" for r in rows),
        "errors": [{"ts": r["ts"], "kind": r["kind"], "where": r.get("where"),
                    "error": str(r.get("error") or r.get("message") or "")[:300]} for r in errors],
    }
