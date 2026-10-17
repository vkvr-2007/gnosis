"""Paired phones and who may talk to Gnosis.

The dashboard on the laptop itself is trusted. Anything else (the phone over Wi-Fi or Tailscale) must
send a device token, which it gets by scanning a short-lived pairing code shown on the dashboard.
"""

from __future__ import annotations

import hashlib
import ipaddress
import json
import secrets
import sqlite3
import threading
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any

_SCHEMA = """
CREATE TABLE IF NOT EXISTS devices (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    token_hash TEXT NOT NULL UNIQUE,
    push TEXT,                 -- Web Push subscription (JSON), if the phone allowed notifications
    created REAL NOT NULL,
    last_seen REAL
);
"""

PAIRING_TTL_S = 300
_LOCAL_HOSTS = {"localhost", "127.0.0.1", "[::1]", "::1"}
_PROXY_HEADERS = ("x-forwarded-for", "forwarded", "x-real-ip", "tailscale-user-login")


def _hash(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


@dataclass
class Device:
    id: int
    name: str
    created: float
    last_seen: float | None
    push: dict[str, Any] | None = None

    def to_dict(self) -> dict[str, Any]:
        return {"id": self.id, "name": self.name, "created": self.created, "last_seen": self.last_seen,
                "notifications": self.push is not None}


def is_local_request(client_host: str | None, host_header: str | None, headers: dict[str, str]) -> bool:
    """True only for the browser on this laptop talking to Gnosis directly.

    A request relayed by a proxy (such as `tailscale serve`) arrives from 127.0.0.1 too, so proxy headers
    make it remote. Checking the Host header stops a web page from reaching Gnosis through DNS rebinding.
    """
    try:
        loopback = client_host is not None and ipaddress.ip_address(client_host).is_loopback
    except ValueError:
        loopback = client_host == "testclient"  # FastAPI's TestClient
    if not loopback or any(h in headers for h in _PROXY_HEADERS):
        return False
    host = (host_header or "").lower()
    host = host.rsplit(":", 1)[0] if not host.endswith("]") else host
    return host in _LOCAL_HOSTS or host == "testserver"


class Devices:
    def __init__(self, db_path: Path | str, clock=time.time):
        self._lock = threading.Lock()
        self._db = sqlite3.connect(str(db_path), check_same_thread=False)
        self._db.row_factory = sqlite3.Row
        self._db.executescript(_SCHEMA)
        self.clock = clock
        self._codes: dict[str, float] = {}  # pairing code -> expiry

    def new_pairing_code(self) -> tuple[str, float]:
        code = secrets.token_urlsafe(12)
        expires = self.clock() + PAIRING_TTL_S
        self._codes = {c: e for c, e in self._codes.items() if e > self.clock()}
        self._codes[code] = expires
        return code, expires

    def claim(self, code: str, name: str) -> tuple[Device, str] | None:
        """Swaps a pairing code (once, before it expires) for a long-lived device token."""
        expires = self._codes.pop(code, None)
        if expires is None or expires < self.clock():
            return None
        token = secrets.token_urlsafe(32)
        with self._lock:
            cur = self._db.execute("INSERT INTO devices (name, token_hash, created) VALUES (?, ?, ?)",
                                   (name[:60] or "Phone", _hash(token), self.clock()))
            self._db.commit()
        return self.get(cur.lastrowid), token

    def _device(self, row: sqlite3.Row) -> Device:
        return Device(row["id"], row["name"], row["created"], row["last_seen"],
                      json.loads(row["push"]) if row["push"] else None)

    def get(self, device_id: int) -> Device | None:
        with self._lock:
            row = self._db.execute("SELECT * FROM devices WHERE id = ?", (device_id,)).fetchone()
        return self._device(row) if row else None

    def verify(self, token: str | None) -> Device | None:
        if not token:
            return None
        with self._lock:
            row = self._db.execute("SELECT * FROM devices WHERE token_hash = ?", (_hash(token),)).fetchone()
            if row is None:
                return None
            self._db.execute("UPDATE devices SET last_seen = ? WHERE id = ?", (self.clock(), row["id"]))
            self._db.commit()
        return self._device(row)

    def all(self) -> list[Device]:
        with self._lock:
            rows = self._db.execute("SELECT * FROM devices ORDER BY id").fetchall()
        return [self._device(r) for r in rows]

    def set_push(self, device_id: int, subscription: dict[str, Any] | None) -> None:
        with self._lock:
            self._db.execute("UPDATE devices SET push = ? WHERE id = ?",
                             (json.dumps(subscription) if subscription else None, device_id))
            self._db.commit()

    def remove(self, device_id: int) -> bool:
        with self._lock:
            cur = self._db.execute("DELETE FROM devices WHERE id = ?", (device_id,))
            self._db.commit()
        return cur.rowcount > 0
