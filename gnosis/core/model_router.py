"""Decides which model serves each call: Nebius in the cloud, or the local Nemotron Nano."""

from __future__ import annotations

import os
from dataclasses import dataclass
from typing import Any, Iterable


@dataclass(frozen=True)
class Route:
    role: str
    provider: str
    model: str
    base_url: str
    api_key: str | None
    is_local: bool
    reason: str
    timeout_s: float = 60.0
    system_prefix: str | None = None  # e.g. "detailed thinking off" for Nemotron Nano
    # Only these tools are offered to this model (None = all). A small local model reads every tool
    # description on every call, so fewer tools means faster and more reliable answers.
    tools: frozenset[str] | None = None
    temperature: float | None = None  # None = the server's default; small local models need 0
    # Provider-specific request fields, e.g. {"chat_template_kwargs": {"enable_thinking": false}}
    extra_body: dict | None = None


class ModelRouter:
    def __init__(self, models_cfg: dict[str, Any]):
        self.providers: dict[str, Any] = models_cfg.get("providers", {})
        self.roles: dict[str, Any] = models_cfg.get("roles", {})
        routing = models_cfg.get("routing", {})
        self.private_tags = set(routing.get("private_tags", []))
        self.offline_fallback = set(routing.get("offline_fallback", []))
        if "local" not in self.roles:
            raise ValueError("models.yaml must define a 'local' role")

    def _route_for(self, role: str, reason: str) -> Route:
        if role not in self.roles:
            raise KeyError(f"Unknown model role: {role}")
        spec = self.roles[role]
        provider = self.providers[spec["provider"]]
        key_env = provider.get("api_key_env")
        on_device = bool(provider.get("on_device", False))
        return Route(
            role=role,
            provider=spec["provider"],
            model=spec["model"],
            base_url=provider["base_url"],
            api_key=os.environ.get(key_env) if key_env else None,
            is_local=on_device,
            reason=reason,
            # A small model on a laptop GPU can take minutes to read Gnosis's prompt and tools.
            timeout_s=float(provider.get("timeout_s", 300 if on_device else 60)),
            system_prefix=spec.get("system_prefix"),
            tools=frozenset(spec["tools"]) if spec.get("tools") else None,
            temperature=float(spec["temperature"]) if spec.get("temperature") is not None else None,
            extra_body=dict(spec["extra_body"]) if spec.get("extra_body") else None,
        )

    def choose(self, role: str, tags: Iterable[str] = (), online: bool = True) -> Route:
        hit = self.private_tags.intersection(tags)
        if hit:
            return self._route_for("local", f"private data ({', '.join(sorted(hit))})")
        if not online:
            if role in self.offline_fallback or role == "local":
                return self._route_for("local", "offline")
            raise RuntimeError(f"The '{role}' model needs the internet and Gnosis is offline")
        return self._route_for(role, "default")

    def embedding_route(self) -> Route | None:
        """The embedding model for memory search. Only an on-device provider is accepted."""
        spec = self.roles.get("embed")
        if not spec:
            return None
        route = self._route_for("embed", "memory search")
        if not route.is_local:
            raise ValueError("models.yaml: the 'embed' role must use an on_device provider (memory is private)")
        return route

    def fallback(self, route: Route) -> Route | None:
        """The local route to try when a cloud call fails, if this role allows it."""
        if route.is_local or route.role not in self.offline_fallback:
            return None
        return self._route_for("local", "cloud unreachable")
