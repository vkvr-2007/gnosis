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
from gnosis.core.llm import ModelError

DASHBOARD_DIR = REPO_ROOT / "web" / "dashboard"


class ChatRequest(BaseModel):
    text: str = Field(min_length=1, max_length=8000)
    session_id: str = "default"
    private: bool = False


class ApprovalAnswer(BaseModel):
    approved: bool


class FactIn(BaseModel):
    subject: str = Field(min_length=1, max_length=200)
    predicate: str = Field(min_length=1, max_length=100)
    value: str = Field(min_length=1, max_length=2000)
    sensitive: bool = False


class FactPatch(BaseModel):
    value: str | None = Field(default=None, min_length=1, max_length=2000)
    pinned: bool | None = None
    sensitive: bool | None = None


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
        except ModelError as e:
            g.audit.write("error", where="chat", error=str(e))
            raise HTTPException(502, f"Model error: {e}")
        except Exception as e:
            g.audit.write("error", where="chat", error=f"{type(e).__name__}: {e}")
            raise HTTPException(500, f"Gnosis hit an error: {type(e).__name__}: {e}")
        return {"answer": answer}

    @app.post("/api/stop")
    async def stop() -> dict:
        return {"stopped": await g.stop_all()}

    @app.get("/api/approvals")
    async def approvals() -> list[dict]:
        return [{"id": a.id, "tool": a.tool, "args": a.args, "reason": a.reason}
                for a in g.approvals.pending.values()]

    @app.post("/api/approvals/{approval_id}")
    async def answer_approval(approval_id: str, body: ApprovalAnswer) -> dict:
        if not g.approvals.resolve(approval_id, body.approved):
            raise HTTPException(404, "No pending approval with that id")
        return {"ok": True}

    @app.get("/api/memory")
    async def memory() -> dict:
        return {"facts": [f.to_dict() for f in g.memory.store.facts()],
                "episodes": [e.to_dict() for e in g.memory.store.episodes(50)]}

    @app.get("/api/memory/graph")
    async def memory_graph() -> dict:
        return g.memory.graph()

    @app.post("/api/memory/facts")
    async def add_fact(body: FactIn) -> dict:
        fact = g.memory.remember(body.subject, body.predicate, body.value, body.sensitive)
        g.audit.write("memory_edit", action="add", fact_id=fact.id)
        return fact.to_dict()

    @app.patch("/api/memory/facts/{fact_id}")
    async def edit_fact(fact_id: int, body: FactPatch) -> dict:
        fact = g.memory.store.update_fact(fact_id, value=body.value, pinned=body.pinned,
                                          sensitive=body.sensitive)
        if fact is None:
            raise HTTPException(404, "No fact with that id")
        g.audit.write("memory_edit", action="edit", fact_id=fact_id)
        return fact.to_dict()

    @app.delete("/api/memory/facts/{fact_id}")
    async def forget_fact(fact_id: int) -> dict:
        if not g.memory.store.delete_fact(fact_id):
            raise HTTPException(404, "No fact with that id")
        g.audit.write("memory_edit", action="forget", fact_id=fact_id)
        return {"ok": True}

    @app.delete("/api/memory/episodes/{episode_id}")
    async def forget_episode(episode_id: int) -> dict:
        if not g.memory.store.delete_episode(episode_id):
            raise HTTPException(404, "No episode with that id")
        g.audit.write("memory_edit", action="forget_episode", episode_id=episode_id)
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
