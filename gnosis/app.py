"""Wires the Gnosis components together."""

from __future__ import annotations

import asyncio
import sys
from dataclasses import dataclass, field
from typing import Any

from gnosis.attachments import Inbox
from gnosis.config import Settings
from gnosis.core.audit import AuditLog
from gnosis.core.events import EventBus
from gnosis.core.llm import LLMClient
from gnosis.core.model_router import ModelRouter
from gnosis.core.orchestrator import Orchestrator
from gnosis.core.policy import ApprovalManager, Grants, Policy
from gnosis.core.tools import ToolRegistry
from gnosis.memory.memory import Memory
from gnosis.memory.store import MemoryStore
from gnosis.coder.sandbox import default_sandbox
from gnosis.phone.adb import Phone, find_adb, subprocess_runner
from gnosis.phone.devices import Devices
from gnosis.phone.push import WebPush
from gnosis.proactive import Notice, Notifier, Watchers
from gnosis.scheduler import Job, JobStore, Scheduler, parse_time
from gnosis.skills.builtin import register_builtin
from gnosis.skills.desktop import register_desktop_tools
from gnosis.skills.vision_tools import register_vision_tools
from gnosis.skills.memory_tools import register_memory_tools
from gnosis.skills.coder_tools import register_coder_tools
from gnosis.skills.phone_tools import register_phone_tools
from gnosis.skills.scheduler_tools import register_scheduler_tools
from gnosis.skills.task_tools import register_task_tools
from gnosis.skills.teach_tools import register_teach_tools, skills_context
from gnosis.teach.skills import SkillStore


@dataclass
class Gnosis:
    settings: Settings
    events: EventBus
    audit: AuditLog
    policy: Policy
    approvals: ApprovalManager
    tools: ToolRegistry
    llm: LLMClient
    memory: Memory
    orchestrator: Orchestrator
    on_stop: list = field(default_factory=list)  # Extra things the kill switch stops, e.g. speech
    notifier: Any = None
    scheduler: Any = None
    watchers: Any = None
    devices: Any = None
    push: Any = None
    phone: Any = None
    inbox: Any = None
    _stt: Any = None
    _jobs: set = field(default_factory=set)  # Routines running in the background

    def transcribe_file(self, file: Any) -> str:
        """Speech to text for a recording from the phone (any format ffmpeg/PyAV can read)."""
        from gnosis.voice.elevenlabs import ElevenLabsSTT, api_key

        cfg = self.settings.voice
        if cfg.get("stt") == "elevenlabs" and api_key():
            import httpx

            try:
                return ElevenLabsSTT(api_key(), cfg.get("elevenlabs_stt_model", "scribe_v1")).transcribe_bytes(
                    file.read(), "phone-recording.webm")
            except httpx.HTTPError:
                file.seek(0)  # Fall back to the on-device model below
        from faster_whisper import decode_audio

        if self._stt is None:
            from gnosis.voice.stt import SpeechToText

            self._stt = SpeechToText(self.settings.voice.get("stt_model", "small.en"))
        return self._stt.transcribe(decode_audio(file, sampling_rate=16_000))

    async def run_background(self) -> None:
        """Reminders, routines and watchers: the parts of Gnosis that act without being asked."""
        await asyncio.gather(self.scheduler.run(),
                             self.watchers.run(float(self.settings.proactive.get("check_every_s", 60))))

    async def on_job(self, job: Job, late: bool) -> None:
        if job.kind == "reminder":
            body = job.text + (" (This was due earlier, while Gnosis wasn't running.)" if late else "")
            await self.notifier.notify(Notice("Reminder", body, "high", "reminder"))
            return
        # Routines and briefings run like a request from the owner; the answer comes back as a notice.
        title = "Your briefing" if job.kind == "briefing" else "Routine finished"
        _, task = self.orchestrator.submit(job.text, "routine")

        async def report() -> None:
            try:
                answer = await task
            except Exception as e:
                answer = f"I couldn't finish '{job.text}': {type(e).__name__}: {e}"
            await self.notifier.notify(Notice(title, answer, "high", job.kind))

        reporter = asyncio.create_task(report())
        self._jobs.add(reporter)
        reporter.add_done_callback(self._jobs.discard)

    async def stop_all(self) -> int:
        """The kill switch: cancels running tasks, declines pending approvals and stops speaking."""
        stopped = self.orchestrator.cancel_all()
        self.approvals.reject_all()
        for fn in self.on_stop:
            fn()
        self.audit.write("kill_switch", tasks_stopped=stopped)
        await self.events.publish("stopped", tasks=stopped)
        return stopped


def build(settings: Settings, llm: LLMClient | None = None) -> Gnosis:
    events = EventBus()
    audit = AuditLog(settings.db_path)

    async def on_model_call(info: dict) -> None:
        audit.write("model_call", **info)
        await events.publish("model_call", **info)

    if llm is None:
        llm = LLMClient(ModelRouter(settings.models), listener=on_model_call)
    policy = Policy(settings.policy)
    approvals = ApprovalManager()
    private_tags = set(settings.models.get("routing", {}).get("private_tags", []))
    memory = Memory(MemoryStore(settings.db_path), llm, private_tags=private_tags)
    tools = ToolRegistry()
    register_builtin(tools)
    register_memory_tools(tools, memory)
    if settings.desktop and sys.platform == "win32":
        register_desktop_tools(tools, llm)
    orchestrator = Orchestrator(llm, tools, policy, approvals, audit, events, memory=memory,
                                grants=Grants(settings.data_dir / "grants.json"),
                                max_steps=settings.max_steps,
                                approval_timeout_s=settings.approval_timeout_s,
                                max_parallel=settings.max_parallel)
    register_task_tools(tools, orchestrator)
    skills = SkillStore(settings.data_dir / "skills")
    register_teach_tools(tools, orchestrator, skills)
    orchestrator.context_providers.append(skills_context(skills))

    g = Gnosis(settings, events, audit, policy, approvals, tools, llm, memory, orchestrator)
    proactive = settings.proactive
    g.notifier = Notifier(events, audit, proactive)
    g.scheduler = Scheduler(JobStore(settings.db_path), g.on_job, events)
    watch_cfg = dict(proactive.get("watchers") or {})
    try:
        import psutil  # noqa: F401  (battery readings; installed with the desktop extra)
    except ImportError:
        watch_cfg["battery"] = False
    g.watchers = Watchers(g.notifier, watch_cfg)
    register_scheduler_tools(tools, g.scheduler, g.notifier, g.watchers)

    g.devices = Devices(settings.db_path)
    g.push = WebPush(g.devices, settings.data_dir)
    g.notifier.push = g.push.send if g.push.available else None
    adb = find_adb(settings.data_dir)
    g.phone = Phone(subprocess_runner(adb) if adb else None, settings.data_dir / "phone.json")
    if settings.phone.get("adb", True):
        register_phone_tools(tools, g.phone, memory)

    g.inbox = Inbox(settings.data_dir / "inbox")
    g.inbox.clean()
    register_vision_tools(tools, llm, g.inbox, camera=settings.desktop and sys.platform == "win32")

    sandbox = default_sandbox(settings.data_dir, settings.coder.get("distro", "Gnosis"))
    register_coder_tools(tools, sandbox, g.notifier, settings.coder.get("isolated"))

    morning = proactive.get("morning_briefing")
    if morning:
        when = parse_time(str(morning), None, g.scheduler.clock())
        g.scheduler.store.add("briefing", "Give me my morning briefing.", when, "daily", key="morning-briefing")
    else:
        for j in g.scheduler.store.upcoming():
            if j.key == "morning-briefing":
                g.scheduler.store.cancel(j.id)
    return g
