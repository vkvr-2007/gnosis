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
        return Route(
            role=role,
            provider=spec["provider"],
            model=spec["model"],
            base_url=provider["base_url"],
            api_key=os.environ.get(key_env) if key_env else None,
            is_local=bool(provider.get("on_device", False)),
            reason=reason,
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
