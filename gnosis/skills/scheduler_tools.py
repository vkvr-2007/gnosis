"""Tools for reminders, routines, do-not-disturb and briefings."""

from __future__ import annotations

import datetime as dt
from typing import Any

from gnosis.core.tools import ToolRegistry
from gnosis.core.workers import match_task
from gnosis.scheduler import REPEATS, Scheduler, parse_time

_WHEN = {
    "at": {"type": "string",
           "description": "Local date-time in ISO format (2026-10-18T09:00), or just HH:MM for the next time it comes round"},
    "in_minutes": {"type": "number", "description": "Instead of 'at': how many minutes from now"},
    "repeat": {"type": "string", "enum": list(REPEATS), "description": "How often it repeats (default once)"},
    "every_minutes": {"type": "integer", "description": "For repeat = 'minutes'"},
}


def register_scheduler_tools(registry: ToolRegistry, scheduler: Scheduler, notifier: Any, watchers: Any) -> None:
    def add(kind: str, text: str, at: str | None, in_minutes: float | None, repeat: str, every_minutes: int) -> dict:
        try:
            when = parse_time(at, in_minutes, scheduler.clock())
            if when <= scheduler.clock():
                return {"error": "That time has already passed"}
            job = scheduler.add(kind, text, when, repeat or "once", int(every_minutes or 0))
        except ValueError as e:
            return {"error": str(e)}
        return {"scheduled": job.to_dict()}

    @registry.tool("set_reminder", "Remind the owner of something at a time, once or repeating.",
                   {"type": "object", "properties": {"text": {"type": "string", "description": "What to remind them of"},
                                                     **_WHEN}, "required": ["text"]})
    def set_reminder(text: str, at: str | None = None, in_minutes: float | None = None, repeat: str = "once",
                     every_minutes: int = 0) -> dict:
        return add("reminder", text, at, in_minutes, repeat, every_minutes)

    @registry.tool("schedule_routine",
                   "Have Gnosis do a task by itself later or on a schedule, e.g. 'every weekday at 9 check for "
                   "Windows updates'. The goal runs like a normal request and the result is sent as a notification.",
                   {"type": "object", "properties": {"goal": {"type": "string"}, **_WHEN}, "required": ["goal"]})
    def schedule_routine(goal: str, at: str | None = None, in_minutes: float | None = None, repeat: str = "once",
                         every_minutes: int = 0) -> dict:
        return add("routine", goal, at, in_minutes, repeat, every_minutes)

    @registry.tool("list_reminders", "List upcoming reminders and routines.")
    def list_reminders() -> list[dict]:
        return [j.to_dict() for j in scheduler.store.upcoming()]

    @registry.tool("cancel_reminder", "Cancel a reminder or routine by its id or by words from it.",
                   {"type": "object", "properties": {"which": {"type": "string"}}, "required": ["which"]})
    def cancel_reminder(which: str) -> dict:
        jobs = scheduler.store.upcoming()
        match = match_task(jobs, which)  # Matches on .id and .text, which jobs have too
        if match is None and which.strip().isdigit():
            match = next((j for j in jobs if j.id == int(which)), None)
        if match is None:
            return {"error": f"No reminder matches '{which}'"}
        scheduler.cancel(match.id)
        return {"cancelled": match.to_dict()}

    @registry.tool("do_not_disturb",
                   "Stop Gnosis from interrupting for a while: only urgent things get through, the rest waits for "
                   "the next briefing. minutes = 0 turns it off.",
                   {"type": "object", "properties": {"minutes": {"type": "number"}}, "required": ["minutes"]})
    def do_not_disturb(minutes: float) -> dict:
        until = notifier.do_not_disturb(float(minutes))
        if not until:
            return {"do_not_disturb": "off"}
        return {"do_not_disturb_until": dt.datetime.fromtimestamp(until).strftime("%H:%M")}

    @registry.tool("briefing",
                   "Get what the owner should know right now: reminders coming up today, things Gnosis held back, "
                   "battery, disk and Windows updates. Use for 'good morning', 'what did I miss?' or 'brief me'.")
    def briefing() -> dict:
        now = scheduler.clock()
        end_of_day = dt.datetime.combine(dt.date.fromtimestamp(now), dt.time(23, 59, 59)).timestamp()
        held = notifier.take_pending()
        return {
            "now": dt.datetime.fromtimestamp(now).strftime("%A %d %B, %H:%M"),
            "coming_up_today": [j.to_dict() for j in scheduler.store.upcoming()
                                if j.next_run <= end_of_day and j.kind != "briefing"],
            "while_you_were_away": [{"title": n.title, "body": n.body} for n in held],
            "laptop": watchers.state,
        }
