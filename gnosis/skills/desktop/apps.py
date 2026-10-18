"""Finding, opening and closing Windows apps."""

from __future__ import annotations

import json
import os
import re
import subprocess
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any
from urllib.parse import quote, quote_plus

try:
    from rapidfuzz import fuzz, process
except ImportError:  # Keep matching usable without rapidfuzz, just less forgiving.
    fuzz = process = None


@dataclass
class AppEntry:
    name: str
    kind: str              # "shortcut" (.lnk / .exe / .url), "uwp" (Store app) or "special"
    target: str            # Path, AUMID, or command for special launchers
    args: list[str] = field(default_factory=list)


# Apps people ask for by a different name than their Start menu entry.
ALIASES = {
    "valorant": "VALORANT",
    "league": "League of Legends",
    "lol": "League of Legends",
    "vs code": "Visual Studio Code",
    "vscode": "Visual Studio Code",
    "code": "Visual Studio Code",
    "word": "Word",
    "excel": "Excel",
    "powerpoint": "PowerPoint",
    "chrome": "Google Chrome",
    "edge": "Microsoft Edge",
    "file explorer": "File Explorer",
    "explorer": "File Explorer",
    "terminal": "Terminal",
    "cmd": "Command Prompt",
    "settings": "Settings",
    "calculator": "Calculator",
    "notepad": "Notepad",
    "whatsapp": "WhatsApp",
}

# Games that must be started through their launcher with arguments.
RIOT = [r"C:\Riot Games\Riot Client\RiotClientServices.exe",
        r"D:\Riot Games\Riot Client\RiotClientServices.exe"]
SPECIAL_LAUNCHERS = {
    "VALORANT": (RIOT, ["--launch-product=valorant", "--launch-patchline=live"]),
    "League of Legends": (RIOT, ["--launch-product=league_of_legends", "--launch-patchline=live"]),
}

# Websites to open when an app isn't installed.
WEB_FALLBACKS = {
    "spotify": "https://open.spotify.com",
    "whatsapp": "https://web.whatsapp.com",
    "youtube": "https://www.youtube.com",
    "gmail": "https://mail.google.com",
    "outlook": "https://outlook.live.com",
    "netflix": "https://www.netflix.com",
    "chatgpt": "https://chatgpt.com",
    "instagram": "https://www.instagram.com",
    "github": "https://github.com",
    "google docs": "https://docs.google.com",
    "google sheets": "https://sheets.google.com",
    "google": "https://www.google.com",
    "notebooklm": "https://notebooklm.google.com",
    "notebook lm": "https://notebooklm.google.com",
    "gemini": "https://gemini.google.com",
    "google drive": "https://drive.google.com",
    "google calendar": "https://calendar.google.com",
    "linkedin": "https://www.linkedin.com",
}

_VIDEO = re.compile(r'"videoRenderer":\{"videoId":"([\w-]{11})".*?"title":\{"runs":\[\{"text":"((?:[^"\\]|\\.)*)"', re.S)


def youtube_search_url(query: str) -> str:
    return "https://www.youtube.com/results?search_query=" + quote_plus(query)


def parse_youtube_results(html: str, limit: int = 3) -> list[dict]:
    """The videos on a YouTube search results page, in order (ads and Shorts shelves aren't videoRenderers)."""
    out, seen = [], set()
    for vid, title in _VIDEO.findall(html):
        if vid not in seen:
            seen.add(vid)
            out.append({"id": vid, "title": json.loads(f'"{title}"'),
                        "url": f"https://www.youtube.com/watch?v={vid}"})
        if len(out) >= limit:
            break
    return out


def youtube_search(query: str, client: Any = None) -> list[dict]:
    import httpx

    r = (client or httpx.Client(timeout=10, follow_redirects=True)).get(
        youtube_search_url(query), headers={"Accept-Language": "en", "User-Agent": "Mozilla/5.0"})
    r.raise_for_status()
    return parse_youtube_results(r.text)


def start_menu_dirs() -> list[Path]:
    dirs = []
    for env in ("ProgramData", "APPDATA"):
        base = os.environ.get(env)
        if base:
            dirs.append(Path(base) / "Microsoft" / "Windows" / "Start Menu" / "Programs")
    return dirs


def scan_shortcuts(dirs: list[Path]) -> list[AppEntry]:
    entries = []
    skip = ("uninstall", "readme", "help", "documentation", "release notes", "website")
    for d in dirs:
        if not d.exists():
            continue
        for p in d.rglob("*"):
            if p.suffix.lower() in (".lnk", ".url", ".exe") and not any(s in p.stem.lower() for s in skip):
                entries.append(AppEntry(p.stem, "shortcut", str(p)))
    return entries


def scan_store_apps() -> list[AppEntry]:
    """Store and system apps (Calculator, Settings, WhatsApp...) via PowerShell's Get-StartApps."""
    try:
        out = subprocess.run(
            ["powershell", "-NoProfile", "-NonInteractive", "-Command",
             "Get-StartApps | Select-Object Name, AppID | ConvertTo-Json -Compress"],
            capture_output=True, text=True, timeout=20, check=True).stdout
        rows = json.loads(out or "[]")
    except (OSError, subprocess.SubprocessError, json.JSONDecodeError):
        return []
    if isinstance(rows, dict):
        rows = [rows]
    return [AppEntry(r["Name"], "uwp", r["AppID"]) for r in rows if r.get("Name") and r.get("AppID")]


class AppIndex:
    def __init__(self, entries: list[AppEntry] | None = None, exists=os.path.exists):
        self._exists = exists
        self.entries: list[AppEntry] = []
        self._scanned_at = 0.0
        if entries is not None:
            self.set_entries(entries)

    def set_entries(self, entries: list[AppEntry]) -> None:
        # Prefer real shortcuts over Store entries with the same name; keep the first of duplicates.
        by_name: dict[str, AppEntry] = {}
        for e in sorted(entries, key=lambda e: e.kind != "shortcut"):
            by_name.setdefault(e.name.lower(), e)
        for name, (paths, args) in SPECIAL_LAUNCHERS.items():
            path = next((p for p in paths if self._exists(p)), None)
            if path:
                by_name[name.lower()] = AppEntry(name, "special", path, args)
        self.entries = list(by_name.values())
        self._scanned_at = time.monotonic()

    def refresh(self, max_age_s: float = 600) -> None:
        if self.entries and time.monotonic() - self._scanned_at < max_age_s:
            return
        self.set_entries(scan_shortcuts(start_menu_dirs()) + scan_store_apps())

    def find(self, query: str, limit: int = 5) -> list[tuple[AppEntry, float]]:
        """Best matches for what the user called the app, with a 0-100 score."""
        q = ALIASES.get(query.strip().lower(), query.strip())
        names = [e.name for e in self.entries]
        if not names:
            return []
        if process is not None:
            hits = process.extract(q, names, scorer=fuzz.WRatio, limit=limit)
            scored = [(self.entries[i], float(score)) for _, score, i in hits]
        else:
            import difflib
            scored = [(e, 100 * difflib.SequenceMatcher(None, q.lower(), e.name.lower()).ratio())
                      for e in self.entries]
            scored = sorted(scored, key=lambda x: x[1], reverse=True)[:limit]
        # An exact name always wins over a fuzzy one.
        exact = [(e, 100.0) for e in self.entries if e.name.lower() == q.lower()]
        return (exact + [s for s in scored if s[0] not in [e for e, _ in exact]])[:limit]

    def best(self, query: str, min_score: float = 80) -> AppEntry | None:
        hits = self.find(query, limit=1)
        return hits[0][0] if hits and hits[0][1] >= min_score else None


def launch(entry: AppEntry) -> None:
    if entry.kind == "special":
        subprocess.Popen([entry.target, *entry.args], close_fds=True)
    elif entry.kind == "uwp":
        subprocess.Popen(["explorer.exe", f"shell:AppsFolder\\{entry.target}"], close_fds=True)
    else:
        os.startfile(entry.target)  # noqa: S606 - opening a Start menu shortcut is the point


def open_url(url: str) -> None:
    os.startfile(url)


def web_fallback(query: str) -> str | None:
    return WEB_FALLBACKS.get(query.strip().lower())


def spotify_search_uri(query: str) -> str:
    return "spotify:search:" + quote(query)


def spotify_web_search(query: str) -> str:
    return "https://open.spotify.com/search/" + quote(query)
