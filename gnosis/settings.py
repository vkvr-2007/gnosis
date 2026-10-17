"""Settings: defaults in code, overridden by config/settings.toml. Secrets only ever come from the environment."""

from __future__ import annotations

import os
import tomllib
from dataclasses import dataclass, field, fields, replace
from pathlib import Path

from gnosis.identity import REPO_ROOT

SETTINGS_FILE = REPO_ROOT / "config" / "settings.toml"


@dataclass(frozen=True)
class BrainSettings:
    base_url: str = "https://integrate.api.nvidia.com/v1"
    model: str = "nvidia/nemotron-3-super-120b-a12b"
    api_key_env: str = "NVIDIA_API_KEY"
    thinking: bool = False
    max_tokens: int = 1024
    temperature: float = 0.6
    timeout_s: float = 60.0

    def api_key(self) -> str | None:
        return os.environ.get(self.api_key_env) or None


@dataclass(frozen=True)
class ConversationSettings:
    history_messages: int = 30
    timezone: str = ""


@dataclass(frozen=True)
class AppSettings:
    data_dir: str = ""


@dataclass(frozen=True)
class Settings:
    brain: BrainSettings = field(default_factory=BrainSettings)
    conversation: ConversationSettings = field(default_factory=ConversationSettings)
    app: AppSettings = field(default_factory=AppSettings)

    @property
    def data_dir(self) -> Path:
        return Path(self.app.data_dir or os.environ.get("GNOSIS_DATA_DIR") or Path.home() / ".gnosis2")


def _merge(section, values: dict, where: str):
    known = {f.name for f in fields(section)}
    unknown = set(values) - known
    if unknown:
        raise ValueError(f"Unknown setting(s) in [{where}]: {', '.join(sorted(unknown))}")
    return replace(section, **values)


def load_settings(path: Path = SETTINGS_FILE) -> Settings:
    s = Settings()
    if not path.exists():
        return s
    with path.open("rb") as f:
        raw = tomllib.load(f)
    unknown = set(raw) - {"brain", "conversation", "app"}
    if unknown:
        raise ValueError(f"Unknown section(s) in {path.name}: {', '.join(sorted(unknown))}")
    return Settings(
        brain=_merge(s.brain, raw.get("brain", {}), "brain"),
        conversation=_merge(s.conversation, raw.get("conversation", {}), "conversation"),
        app=_merge(s.app, raw.get("app", {}), "app"),
    )
