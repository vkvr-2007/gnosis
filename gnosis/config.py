"""Loads Gnosis settings from config/gnosis.yaml (falling back to the example file)."""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import yaml

REPO_ROOT = Path(__file__).resolve().parent.parent


def _read_yaml(path: Path) -> dict[str, Any]:
    with path.open(encoding="utf-8") as f:
        return yaml.safe_load(f) or {}


def resolve(path: str | Path, base: Path = REPO_ROOT) -> Path:
    """Expands ~ and makes relative paths relative to the repo root."""
    p = Path(path).expanduser()
    return p if p.is_absolute() else base / p


@dataclass
class Settings:
    host: str = "127.0.0.1"
    port: int = 8765
    data_dir: Path = field(default_factory=lambda: Path("~/.gnosis").expanduser())
    models: dict[str, Any] = field(default_factory=dict)
    policy: dict[str, Any] = field(default_factory=dict)
    max_steps: int = 25  # Building a website takes many write-build-fix rounds
    approval_timeout_s: float = 120.0
    max_parallel: int = 4  # Tasks that may run at the same time
    voice: dict[str, Any] = field(default_factory=dict)
    kill_switch: str = "ctrl+alt+j"
    proactive: dict[str, Any] = field(default_factory=dict)
    phone: dict[str, Any] = field(default_factory=dict)
    coder: dict[str, Any] = field(default_factory=dict)
    desktop: bool = True  # Register desktop control tools (Windows only)

    @property
    def db_path(self) -> Path:
        return self.data_dir / "gnosis.db"


def load_settings(config_path: str | Path | None = None) -> Settings:
    if config_path is None:
        config_path = REPO_ROOT / "config" / "gnosis.yaml"
        if not config_path.exists():
            config_path = REPO_ROOT / "config" / "gnosis.example.yaml"
    raw = _read_yaml(resolve(config_path))

    server = raw.get("server", {})
    orch = raw.get("orchestrator", {})
    settings = Settings(
        host=server.get("host", "127.0.0.1"),
        port=int(server.get("port", 8765)),
        data_dir=resolve(raw.get("data_dir", "~/.gnosis")),
        models=_read_yaml(resolve(raw.get("models_file", "config/models.yaml"))),
        policy=_read_yaml(resolve(raw.get("policy_file", "config/policy.yaml"))),
        max_steps=int(orch.get("max_steps", 25)),
        approval_timeout_s=float(orch.get("approval_timeout_s", 120)),
        max_parallel=int(orch.get("max_parallel", 4)),
        voice=raw.get("voice") or {},
        kill_switch=str(raw.get("kill_switch", "ctrl+alt+j")),
        proactive=raw.get("proactive") or {},
        phone=raw.get("phone") or {},
        coder=raw.get("coder") or {},
    )
    settings.data_dir.mkdir(parents=True, exist_ok=True)
    return settings
