"""Phone bridge: pairing, the device-token check, push subscriptions and voice from the phone."""

from __future__ import annotations

import asyncio
import io
import socket
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, urlparse

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from gnosis.config import REPO_ROOT
from gnosis.phone.devices import is_local_request

PHONE_DIR = REPO_ROOT / "web" / "phone"
_PUBLIC = {"/api/health", "/api/phone/claim"}
_MAX_AUDIO_BYTES = 10 * 1024 * 1024


class TokenGuard:
    """Lets the laptop's own browser in, and anything else only with a paired device's token.

    Pure ASGI so it covers WebSockets too. Requests that other websites make from the laptop's browser
    are refused by their Origin.
    """

    def __init__(self, app, devices):
        self.app = app
        self.devices = devices

    async def __call__(self, scope, receive, send):
        if scope["type"] not in ("http", "websocket"):
            return await self.app(scope, receive, send)
        headers = {k.decode().lower(): v.decode() for k, v in scope.get("headers", [])}
        client = scope.get("client") or (None, None)
        local = is_local_request(client[0], headers.get("host"), headers)
        path = scope.get("path", "")
        scope.setdefault("state", {})
        scope["state"].update(local=local, device=None)

        origin = headers.get("origin")
        if local and origin and urlparse(origin).netloc != headers.get("host"):
            # Another website's page in the laptop's browser; a phone proves itself with its token instead.
            return await self._deny(scope, receive, send, "Cross-site request refused")
        if not local and (path.startswith("/api/") or path == "/ws") and path not in _PUBLIC:
            token = headers.get("authorization", "").removeprefix("Bearer ").strip()
            if not token and scope["type"] == "websocket":
                token = parse_qs(scope.get("query_string", b"").decode()).get("token", [""])[0]
            device = self.devices.verify(token)
            if device is None:
                return await self._deny(scope, receive, send, "Pair this device first")
            scope["state"]["device"] = device
        await self.app(scope, receive, send)

    async def _deny(self, scope, receive, send, message: str):
        if scope["type"] == "websocket":
            await send({"type": "websocket.close", "code": 4401})
            return
        await JSONResponse({"detail": message}, status_code=401)(scope, receive, send)


def lan_address() -> str:
    """This laptop's address on the local network (no packets are sent)."""
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
        try:
            s.connect(("10.255.255.255", 1))
            return s.getsockname()[0]
        except OSError:
            return "127.0.0.1"


class Claim(BaseModel):
    code: str = Field(min_length=8, max_length=64)
    name: str = Field(default="Phone", max_length=60)


class PushSubscription(BaseModel):
    subscription: dict[str, Any] | None


def add_phone_routes(app: FastAPI, g) -> None:
    def local_only(request: Request) -> None:
        if not request.state.local:
            raise HTTPException(403, "Only the dashboard on the laptop can do this")

    @app.post("/api/phone/pair")
    async def pair(request: Request) -> dict:
        """A one-time code for the dashboard to show as a QR code."""
        local_only(request)
        import segno

        code, expires = g.devices.new_pairing_code()
        base = g.settings.phone.get("url") or f"http://{lan_address()}:{g.settings.port}"
        url = f"{base.rstrip('/')}/phone/#pair={code}"
        return {"url": url, "expires": expires,
                "qr_svg": segno.make(url, error="m").svg_inline(scale=5, dark="#000", light="#fff"),
                "lan_only": g.settings.host in ("127.0.0.1", "localhost") and not g.settings.phone.get("url")}

    @app.post("/api/phone/claim")
    async def claim(body: Claim) -> dict:
        result = g.devices.claim(body.code, body.name)
        if result is None:
            raise HTTPException(403, "That pairing code has expired. Show a new one on the laptop.")
        device, token = result
        g.audit.write("phone_paired", device=device.id, name=device.name)
        await g.events.publish("phone_paired", device=device.to_dict())
        return {"token": token, "device": device.to_dict()}

    @app.get("/api/phone/devices")
    async def devices(request: Request) -> list[dict]:
        local_only(request)
        return [d.to_dict() for d in g.devices.all()]

    @app.delete("/api/phone/devices/{device_id}")
    async def unpair(device_id: int, request: Request) -> dict:
        local_only(request)
        if not g.devices.remove(device_id):
            raise HTTPException(404, "No device with that id")
        g.audit.write("phone_unpaired", device=device_id)
        return {"ok": True}

    @app.get("/api/phone/push-key")
    async def push_key() -> dict:
        return {"public_key": await asyncio.to_thread(g.push.public_key)}

    @app.post("/api/phone/push")
    async def subscribe(body: PushSubscription, request: Request) -> dict:
        device = request.state.device
        if device is None:
            raise HTTPException(400, "Notifications are for a paired phone")
        g.devices.set_push(device.id, body.subscription)
        return {"ok": True}

    @app.post("/api/phone/voice")
    async def voice(request: Request) -> dict:
        """Push-to-talk from the phone: the recording is transcribed on the laptop and run as a task."""
        audio = await request.body()
        if not audio or len(audio) > _MAX_AUDIO_BYTES:
            raise HTTPException(413, "Recording is empty or too long")
        try:
            text = await asyncio.to_thread(g.transcribe_file, io.BytesIO(audio))
        except ImportError:
            raise HTTPException(501, "Speech recognition isn't installed on the laptop (pip install -e .[voice])")
        if not text:
            return {"text": "", "task": None}
        info, task = g.orchestrator.submit(text, "phone")
        task.add_done_callback(lambda t: t.cancelled() or t.exception())
        return {"text": text, "task": info.to_dict()}

    if PHONE_DIR.exists():
        @app.get("/phone")
        async def phone_root() -> RedirectResponse:
            return RedirectResponse("/phone/")

        app.mount("/phone", StaticFiles(directory=Path(PHONE_DIR), html=True), name="phone")
