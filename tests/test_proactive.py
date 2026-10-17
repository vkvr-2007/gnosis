import asyncio
import datetime as dt

from fastapi.testclient import TestClient

from conftest import FakeLLM, reply, tool_call
from gnosis.app import build
from gnosis.core.audit import AuditLog
from gnosis.core.events import EventBus
from gnosis.proactive import Notice, Notifier, Watchers
from gnosis.scheduler import Job, JobStore, Scheduler, next_after, parse_time
from gnosis.server.api import create_app


def ts(*args):
    return dt.datetime(*args).timestamp()  # Local time, like the scheduler


class Clock:
    def __init__(self, t):
        self.t = t

    def __call__(self):
        return self.t


# ---- times ---------------------------------------------------------------

def test_repeats_keep_the_time_of_day():
    fri_9 = ts(2026, 10, 16, 9, 0)
    job = lambda repeat, every=0: Job(1, "reminder", "x", fri_9, repeat, every)
    assert next_after(job("once"), fri_9) is None
    assert next_after(job("daily"), fri_9) == ts(2026, 10, 17, 9, 0)
    assert next_after(job("weekdays"), fri_9) == ts(2026, 10, 19, 9, 0)  # Skips the weekend
    assert next_after(job("weekly"), fri_9) == ts(2026, 10, 23, 9, 0)
    assert next_after(job("minutes", 20), fri_9 + 3600) == ts(2026, 10, 16, 10, 20)
    # Missed several days while the laptop was off: jumps to the next future time
    assert next_after(job("daily"), ts(2026, 10, 20, 12, 0)) == ts(2026, 10, 21, 9, 0)


def test_parse_time():
    now = ts(2026, 10, 17, 10, 30)
    assert parse_time("11:00", None, now) == ts(2026, 10, 17, 11, 0)
    assert parse_time("09:00", None, now) == ts(2026, 10, 18, 9, 0)  # Already passed today
    assert parse_time("2026-10-20T18:15", None, now) == ts(2026, 10, 20, 18, 15)
    assert parse_time(None, 15, now) == now + 900


# ---- scheduler -----------------------------------------------------------

def test_scheduler_fires_due_jobs_once(tmp_path):
    clock = Clock(ts(2026, 10, 17, 8, 0))
    fired = []

    async def on_fire(job, late):
        fired.append((job.text, late))

    sched = Scheduler(JobStore(tmp_path / "j.db"), on_fire, clock=clock)
    sched.add("reminder", "stretch", ts(2026, 10, 17, 8, 30))
    sched.add("reminder", "standup", ts(2026, 10, 17, 9, 0), "weekdays")

    async def go():
        assert await sched.tick() == 0
        clock.t = ts(2026, 10, 17, 8, 30, 5)
        assert await sched.tick() == 1
        assert await sched.tick() == 0  # Not again
        clock.t = ts(2026, 10, 17, 12, 0)  # Saturday noon: standup fired late, moves to Monday
        await sched.tick()

    asyncio.run(go())
    assert fired == [("stretch", False), ("standup", True)]
    upcoming = sched.store.upcoming()
    assert [(j.text, j.next_run) for j in upcoming] == [("standup", ts(2026, 10, 19, 9, 0))]


# ---- should I speak? -------------------------------------------------------

def notifier(tmp_path, t, **cfg):
    shown, spoken = [], []

    async def speak(text):
        spoken.append(text)

    n = Notifier(EventBus(), AuditLog(tmp_path / "a.db"), {"quiet_hours": "23:00-07:00", **cfg},
                 clock=Clock(t), toast=lambda title, body: shown.append(title), busy=lambda: False)
    n.speakers.append(speak)
    return n, shown, spoken


def test_urgency_quiet_hours_and_do_not_disturb(tmp_path):
    n, shown, spoken = notifier(tmp_path, ts(2026, 10, 17, 14, 0))

    async def go():
        assert await n.notify(Notice("Disk", "low disk", "normal")) == ["toast"]
        assert await n.notify(Notice("Reminder", "call mom", "high")) == ["toast", "speak"]
        assert await n.notify(Notice("Tip", "fyi", "low")) == []
        n.do_not_disturb(30)
        assert await n.notify(Notice("Reminder", "drink water", "high")) == ["toast"]  # Not spoken
        assert await n.notify(Notice("Update", "updates ready", "normal")) == []       # Held back
        assert await n.notify(Notice("Battery", "5%", "urgent")) == ["toast", "speak"]  # Always
        n.clock.t = ts(2026, 10, 17, 23, 30)  # Quiet hours
        n.do_not_disturb(0)
        assert await n.notify(Notice("Disk", "still low", "normal")) == []
        await n.drain()

    asyncio.run(go())
    assert shown == ["Disk", "Reminder", "Reminder", "Battery"]
    assert spoken == ["call mom", "5%"]
    assert [p.title for p in n.take_pending()] == ["Tip", "Update", "Disk"]
    assert n.take_pending() == []


def test_rate_limit_holds_back_chatty_notices(tmp_path):
    n, shown, _ = notifier(tmp_path, ts(2026, 10, 17, 14, 0), max_per_hour=2)

    async def go():
        return [await n.notify(Notice(f"n{i}", "x", "normal")) for i in range(3)]

    assert asyncio.run(go()) == [["toast"], ["toast"], []]


def test_gaming_holds_back_normal_notices(tmp_path):
    n, _, spoken = notifier(tmp_path, ts(2026, 10, 17, 14, 0))
    n.busy = lambda: True
    assert asyncio.run(n.notify(Notice("Update", "updates", "normal"))) == []
    assert asyncio.run(n.notify(Notice("Reminder", "match at 6", "high"))) == ["toast"]


# ---- watchers --------------------------------------------------------------

def test_watchers_warn_once_per_change(tmp_path):
    n, shown, spoken = notifier(tmp_path, ts(2026, 10, 17, 14, 0))
    battery, updates = [(50, False)], [[]]
    w = Watchers(n, {}, battery=lambda: battery[0], disk=lambda: 42.0, updates=lambda: updates[0], clock=n.clock)
    w.updates_every_s = 0

    async def go():
        await w.check()
        battery[0] = (19, False)
        await w.check()
        await w.check()  # Already warned
        battery[0] = (9, False)
        await w.check()
        battery[0] = (9, True)  # Plugged in: warnings reset
        await w.check()
        updates[0] = ["2026-10 Cumulative Update", "Intel Graphics driver"]
        await w.check()
        await w.check()  # Same updates: no new notice
        await n.drain()

    asyncio.run(go())
    assert shown == ["Battery low", "Battery very low", "Windows updates ready"]
    assert spoken[:2] == ["Battery is at 19%. Plug in soon.", "Battery is at 9%. Plug in now."]
    assert w.state["disk_free_percent"] == 42.0 and len(w.state["updates"]) == 2


# ---- in the agent ------------------------------------------------------------

def test_set_reminder_then_it_fires(settings):
    llm = FakeLLM([reply(calls=[tool_call("set_reminder", {"text": "call mom", "in_minutes": 10})]),
                   reply("I'll remind you in 10 minutes.")])
    g = build(settings, llm=llm)
    clock = Clock(ts(2026, 10, 17, 14, 0))
    g.scheduler.clock = g.notifier.clock = clock
    g.notifier.toast, g.notifier.busy = None, lambda: False
    spoken = []

    async def speak(text):
        spoken.append(text)

    g.notifier.speakers.append(speak)

    async def go():
        await g.orchestrator.handle("remind me to call mom in 10 minutes")
        (job,) = g.scheduler.store.upcoming()
        assert job.text == "call mom" and job.next_run == clock.t + 600
        clock.t += 601
        await g.scheduler.tick()
        await g.notifier.drain()

    asyncio.run(go())
    assert spoken == ["call mom"] and g.scheduler.store.upcoming() == []


def test_routine_runs_as_a_task_and_reports(settings):
    g = build(settings, llm=FakeLLM([reply("No new Windows updates.")]))
    g.notifier.toast, g.notifier.busy = None, lambda: False
    got = []

    async def go():
        q = g.events.subscribe()
        await g.on_job(Job(1, "routine", "check for Windows updates", 0), False)
        await asyncio.gather(*g._jobs)
        while not q.empty():
            ev = q.get_nowait()
            if ev["type"] == "notification":
                got.append(ev["notice"])

    asyncio.run(go())
    assert got[0]["title"] == "Routine finished" and got[0]["body"] == "No new Windows updates."


def test_briefing_collects_what_was_held_back(settings):
    g = build(settings, llm=FakeLLM([]))
    clock = Clock(ts(2026, 10, 17, 7, 55))
    g.scheduler.clock = clock
    g.scheduler.add("reminder", "dentist", ts(2026, 10, 17, 16, 0))
    g.scheduler.add("reminder", "pay rent", ts(2026, 10, 20, 9, 0))
    g.notifier.pending.append(Notice("Windows updates ready", "2 updates are ready"))
    out = asyncio.run(g.tools.get("briefing").run())
    assert [j["text"] for j in out["coming_up_today"]] == ["dentist"]
    assert out["while_you_were_away"] == [{"title": "Windows updates ready", "body": "2 updates are ready"}]
    assert g.notifier.pending == []


def test_morning_briefing_job_and_reminders_api(settings):
    settings.proactive = {"morning_briefing": "08:00"}
    g = build(settings, llm=FakeLLM([]))
    build(settings, llm=FakeLLM([]))  # Starting again doesn't add a second briefing
    client = TestClient(create_app(g))
    jobs = client.get("/api/reminders").json()
    assert [(j["kind"], j["repeat"]) for j in jobs] == [("briefing", "daily")]
    assert client.delete(f"/api/reminders/{jobs[0]['id']}").json() == {"ok": True}
    assert client.get("/api/reminders").json() == []
    assert client.delete("/api/reminders/999").status_code == 404
