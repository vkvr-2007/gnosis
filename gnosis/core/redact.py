"""Masks secrets before any text is sent to a cloud model."""

from __future__ import annotations

import re

_PATTERNS: list[tuple[str, re.Pattern[str]]] = [
    ("API_KEY", re.compile(r"\b(?:sk|pk|rk|ghp|gho|github_pat|xox[abp])[-_][A-Za-z0-9_\-]{16,}\b")),
    ("JWT", re.compile(r"\beyJ[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+\b")),
    # A cut-off token still leaks most of it, e.g. a key shown in a tab title.
    ("JWT", re.compile(r"\beyJ[A-Za-z0-9_\-.]{16,}")),
    ("API_KEY", re.compile(r"\b(?:sb_(?:publishable|secret)_[A-Za-z0-9_\-]{10,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_\-]{35})")),
    ("CARD", re.compile(r"\b(?:\d[ -]?){13,16}\b")),
    ("PASSWORD", re.compile(r"(?i)\b(password|passwd|pwd)\s*[:=]\s*\S+")),
    ("SECRET", re.compile(r"(?i)\b(\w*(?:(?:api|anon|service)[_-]?key|secret|access[_-]?token|auth[_-]?token))"
                          r"\s*[:=]\s*[\"']?(?!\[REDACTED)[^\s\"']{8,}")),
    ("PRIVATE_KEY", re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]+?-----END [A-Z ]*PRIVATE KEY-----")),
]


def redact(text: str) -> tuple[str, int]:
    """Returns the redacted text and how many values were masked."""
    count = 0
    for label, pattern in _PATTERNS:
        if label in ("PASSWORD", "SECRET"):
            text, n = pattern.subn(lambda m: f"{m.group(1)}: [REDACTED_{label}]", text)
        else:
            text, n = pattern.subn(f"[REDACTED_{label}]", text)
        count += n
    return text, count
