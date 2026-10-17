"""Who Gnosis is: the name, wake words and voice, set in one file (config/identity.json)."""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
IDENTITY_FILE = REPO_ROOT / "config" / "identity.json"


@dataclass(frozen=True)
class Identity:
    name: str = "Gnosis"
    tagline: str = ""
    wake_words: tuple[str, ...] = ("hey gnosis",)
    address_as: str = ""
    language: str = "en"
    voice: dict = field(default_factory=dict)


def load_identity(path: Path = IDENTITY_FILE) -> Identity:
    if not path.exists():
        return Identity()
    raw = json.loads(path.read_text(encoding="utf-8"))
    if not str(raw.get("name", "")).strip():
        raise ValueError(f"{path} needs a name")
    return Identity(
        name=raw["name"].strip(),
        tagline=raw.get("tagline", ""),
        wake_words=tuple(w.lower().strip() for w in raw.get("wake_words", []) if w.strip()),
        address_as=raw.get("address_as", ""),
        language=raw.get("language", "en"),
        voice=dict(raw.get("voice", {})),
    )
