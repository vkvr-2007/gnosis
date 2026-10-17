"""Notifications on the phone through Web Push (needs the `phone` extra: pywebpush).

The push service (Google's, for Chrome on Android) only carries an encrypted payload; it can't read it.
"""

from __future__ import annotations

import asyncio
import base64
import json
from pathlib import Path
from typing import Any

from gnosis.phone.devices import Devices


class WebPush:
    def __init__(self, devices: Devices, data_dir: Path, contact: str = "mailto:gnosis@localhost"):
        self.devices = devices
        self.key_path = data_dir / "vapid_private.pem"
        self.contact = contact
        self._vapid = None

    @property
    def available(self) -> bool:
        try:
            import pywebpush  # noqa: F401
        except ImportError:
            return False
        return True

    def _keys(self):
        if self._vapid is None:
            from py_vapid import Vapid01

            if self.key_path.exists():
                self._vapid = Vapid01.from_file(str(self.key_path))
            else:
                self._vapid = Vapid01()
                self._vapid.generate_keys()
                self._vapid.save_key(str(self.key_path))
        return self._vapid

    def public_key(self) -> str | None:
        """The key the phone's browser needs to subscribe (base64url, uncompressed P-256 point)."""
        if not self.available:
            return None
        from cryptography.hazmat.primitives import serialization

        raw = self._keys().public_key.public_bytes(serialization.Encoding.X962,
                                                   serialization.PublicFormat.UncompressedPoint)
        return base64.urlsafe_b64encode(raw).rstrip(b"=").decode()

    def _send_all(self, payload: dict[str, Any]) -> int:
        from pywebpush import WebPushException, webpush

        sent = 0
        for device in self.devices.all():
            if not device.push:
                continue
            try:
                webpush(device.push, json.dumps(payload), vapid_private_key=str(self.key_path),
                        vapid_claims={"sub": self.contact}, ttl=3600)
                sent += 1
            except WebPushException as e:
                if e.response is not None and e.response.status_code in (404, 410):
                    self.devices.set_push(device.id, None)  # The phone unsubscribed
        return sent

    async def send(self, title: str, body: str, url: str = "/phone") -> int:
        if not self.available or not any(d.push for d in self.devices.all()):
            return 0
        self._keys()
        return await asyncio.to_thread(self._send_all, {"title": title, "body": body, "url": url})
