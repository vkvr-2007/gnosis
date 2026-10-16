"""Masks secrets before any text is sent to a cloud model."""

from __future__ import annotations

import re

_PATTERNS: list[tuple[str, re.Pattern[str]]] = [
    ("API_KEY", re.compile(r"\b(?:sk|pk|rk|ghp|gho|github_pat|xox[abp])[-_][A-Za-z0-9_\-]{16,}\b")),
    ("JWT", re.compile(r"\beyJ[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+\b")),
    ("CARD", re.compile(r"\b(?:\d[ -]?){13,16}\b")),
    ("PASSWORD", re.compile(r"(?i)\b(password|passwd|pwd)\s*[:=]\s*\S+")),
    ("PRIVATE_KEY", re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]+?-----END [A-Z ]*PRIVATE KEY-----")),
]


def redact(text: str) -> tuple[str, int]:
    """Returns the redacted text and how many values were masked."""
    count = 0
    for label, pattern in _PATTERNS:
        if label == "PASSWORD":
            text, n = pattern.subn(lambda m: f"{m.group(1)}: [REDACTED_{label}]", text)
        else:
            text, n = pattern.subn(f"[REDACTED_{label}]", text)
        count += n
    return text, count
