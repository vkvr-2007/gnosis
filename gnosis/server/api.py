"""Local HTTP + WebSocket API that the dashboard (and later the phone app) talks to."""

from __future__ import annotations

import asyncio
import json
from pathlib import Path

from fastapi import FastAPI, HTTPException, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, RedirectResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from gnosis import diagnostics
from gnosis.app import Gnosis
from gnosis.config import REPO_ROOT
from gnosis.core.llm import ModelError
from gnosis.attachments import MAX_BYTES, AttachmentError
from gnosis.server.phone_api import TokenGuard, add_phone_routes

DASHBOARD_DIR = REPO_ROOT / "web" / "dashboard"


class ChatRequest(BaseModel):
    text: str = Field(min_length=1, max_length=8000)
    session_id: str = "default"
    private: bool = False
    files: list[str] = Field(default_factory=list, max_length=5)  # Attachment ids from /api/files


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
    app.add_middleware(TokenGuard, devices=g.devices)
    add_phone_routes(app, g)

    @app.get("/api/health")
    async def health() -> dict:
        return {"ok": True, "online": g.llm.online, "tools": g.tools.names(),
                "voice": g.events.last.get("voice_state")}

    def request_text(req: ChatRequest) -> str:
        if not req.files:
            return req.text
        try:
            return f"{req.text}\n\n{g.inbox.describe(req.files)}"
        except AttachmentError as e:
            raise HTTPException(400, str(e))

    @app.post("/api/files")
    async def upload(request: Request, name: str = "file") -> dict:
        """One attached file or camera photo, sent as the raw request body."""
        data = await request.body()
        try:
            return g.inbox.save(name, data).to_dict()
        except AttachmentError as e:
            raise HTTPException(413 if len(data) > MAX_BYTES else 400, str(e))

    @app.post("/api/chat")
    async def chat(req: ChatRequest) -> dict:
        tags = {"private"} if req.private else set()
        text = request_text(req)
        try:
            answer = await g.orchestrator.handle(text, req.session_id, tags)
        except ModelError as e:
            g.audit.write("error", where="chat", error=str(e))
            raise HTTPException(502, f"Model error: {e}")
        except Exception as e:
            g.audit.write("error", where="chat", error=f"{type(e).__name__}: {e}")
            raise HTTPException(500, f"Gnosis hit an error: {type(e).__name__}: {e}")
        return {"answer": answer}

    @app.post("/api/chat/stream")
    async def chat_stream(req: ChatRequest) -> StreamingResponse:
        """The answer as server-sent events while it's written: `delta` (more text), `reset` (drop the
        text so far: it led to a tool call), then `done` with the whole answer, or `error`."""
        tags = {"private"} if req.private else set()
        text = request_text(req)
        queue: asyncio.Queue = asyncio.Queue()

        async def on_text(delta: str | None) -> None:
            await queue.put(("reset", "") if delta is None else ("delta", delta))

        async def work() -> None:
            try:
                await queue.put(("done", await g.orchestrator.handle(text, req.session_id, tags, on_text=on_text)))
            except Exception as e:
                g.audit.write("error", where="chat", error=f"{type(e).__name__}: {e}")
                await queue.put(("error", f"{type(e).__name__}: {e}"))

        async def events():
            task = asyncio.create_task(work())
            try:
                while True:
                    kind, data = await queue.get()
                    yield f"event: {kind}\ndata: {json.dumps(data)}\n\n"
                    if kind in ("done", "error"):
                        return
            finally:
                if not task.done():
                    task.cancel()  # The client went away

        return StreamingResponse(events(), media_type="text/event-stream")

    @app.post("/api/tasks")
    async def start_task(req: ChatRequest) -> dict:
        """Starts a request in the background; progress arrives as task_status events."""
        info, task = g.orchestrator.submit(request_text(req), req.session_id, {"private"} if req.private else set())
        task.add_done_callback(lambda t: t.cancelled() or t.exception())  # Failures show on the task card
        return info.to_dict()

    @app.get("/api/tasks")
    async def tasks() -> list[dict]:
        return [t.to_dict() for t in g.orchestrator.list_tasks()]

    @app.post("/api/tasks/{task_id}/{action}")
    async def control_task(task_id: str, action: str) -> dict:
        if action not in ("pause", "resume", "cancel"):
            raise HTTPException(404, "Unknown action")
        if not getattr(g.orchestrator, action)(task_id):
            raise HTTPException(409, f"Can't {action} that task (it may have finished)")
        return {"ok": True}

    @app.get("/api/reminders")
    async def reminders() -> list[dict]:
        return [j.to_dict() for j in g.scheduler.store.upcoming()]

    @app.delete("/api/reminders/{job_id}")
    async def cancel_reminder(job_id: int) -> dict:
        if not g.scheduler.cancel(job_id):
            raise HTTPException(404, "No upcoming reminder with that id")
        await g.events.publish("jobs_changed")
        return {"ok": True}

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
        facts = g.memory.store.facts()
        return {"facts": [f.to_dict() for f in facts if f.source != "phone"],
                "phone_contacts": sum(f.source == "phone" for f in facts),
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

    @app.post("/api/voice/talk")
    async def talk() -> dict:
        """Same as the talk key: listen now (and stop talking if Gnosis is)."""
        if g.voice is None:
            raise HTTPException(409, "Voice is off. Start Gnosis with --voice.")
        await g.voice.push_to_talk()
        return {"ok": True}

    @app.get("/api/diagnostics")
    async def diagnostics_report() -> dict:
        return await diagnostics.collect(g)

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

        @app.get("/", response_model=None)
        async def index(request: Request) -> FileResponse | RedirectResponse:
            if not request.state.local:  # The dashboard is for the laptop; other devices get the phone app
                return RedirectResponse("/phone/")
            return FileResponse(Path(DASHBOARD_DIR) / "index.html")

    return app
