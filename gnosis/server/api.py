"""Local HTTP + WebSocket API that the dashboard (and later the phone app) talks to."""

from __future__ import annotations

import asyncio
from pathlib import Path

from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from gnosis.app import Gnosis
from gnosis.config import REPO_ROOT

DASHBOARD_DIR = REPO_ROOT / "web" / "dashboard"


class ChatRequest(BaseModel):
    text: str = Field(min_length=1, max_length=8000)
    session_id: str = "default"
    private: bool = False


class ApprovalAnswer(BaseModel):
    approved: bool


def create_app(g: Gnosis) -> FastAPI:
    app = FastAPI(title="Gnosis", version="0.1.0")

    @app.get("/api/health")
    async def health() -> dict:
        return {"ok": True, "online": g.llm.online, "tools": g.tools.names()}

    @app.post("/api/chat")
    async def chat(req: ChatRequest) -> dict:
        tags = {"private"} if req.private else set()
        try:
            answer = await g.orchestrator.handle(req.text, req.session_id, tags)
        except Exception as e:
            g.audit.write("error", where="chat", error=f"{type(e).__name__}: {e}")
            raise HTTPException(502, f"Gnosis couldn't reach a model: {type(e).__name__}: {e}")
        return {"answer": answer}

    @app.get("/api/approvals")
    async def approvals() -> list[dict]:
        return [{"id": a.id, "tool": a.tool, "args": a.args, "reason": a.reason}
                for a in g.approvals.pending.values()]

    @app.post("/api/approvals/{approval_id}")
    async def answer_approval(approval_id: str, body: ApprovalAnswer) -> dict:
        if not g.approvals.resolve(approval_id, body.approved):
            raise HTTPException(404, "No pending approval with that id")
        return {"ok": True}

    @app.get("/api/audit")
    async def audit(limit: int = 100) -> list[dict]:
        return g.audit.recent(min(max(limit, 1), 1000))

    @app.websocket("/ws")
    async def ws(socket: WebSocket) -> None:
        await socket.accept()
        queue = g.events.subscribe()
        try:
            while True:
                event = await queue.get()
                await socket.send_json(event)
        except (WebSocketDisconnect, asyncio.CancelledError):
            pass
        finally:
            g.events.unsubscribe(queue)

    if DASHBOARD_DIR.exists():
        app.mount("/static", StaticFiles(directory=DASHBOARD_DIR), name="static")

        @app.get("/")
        async def index() -> FileResponse:
            return FileResponse(Path(DASHBOARD_DIR) / "index.html")

    return app
