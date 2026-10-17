"""Proactive Gnosis: watchers notice things, and a "should I speak?" step decides how to tell you.

Every notice goes through the same decision:
- low: saved for your next briefing;
- normal: a Windows notification, unless it's quiet hours, do-not-disturb, you're gaming or
  presenting, or Gnosis has already said a lot this hour (then it waits for the briefing);
- high (e.g. a reminder you set): a notification, and spoken aloud when that won't interrupt;
- urgent (e.g. battery about to die): always a notification and always spoken.

Anything shown or spoken is also pushed to the paired phone when you're away from the laptop (or always,
or never: `proactive.phone_push`).
"""

from __future__ import annotations

import asyncio
import datetime as dt
import os
import shutil
import subprocess
import sys
import time
from dataclasses import dataclass, field
from typing import Any, Awaitable, Callable

LEVELS = ("low", "normal", "high", "urgent")

# Delivery decisions
QUEUE, TOAST, SPEAK, PHONE = "queue", "toast", "speak", "phone"
AWAY_AFTER_S = 300  # No keyboard or mouse input for this long counts as away from the laptop


@dataclass
class Notice:
    title: str
    body: str
    urgency: str = "normal"
    source: str = "gnosis"
    created: float = field(default_factory=time.time)

    def to_dict(self) -> dict[str, Any]:
        return {"title": self.title, "body": self.body, "urgency": self.urgency, "source": self.source,
                "created": self.created}


def _in_window(window: str | None, now: dt.datetime) -> bool:
    """True if `now` falls in a "HH:MM-HH:MM" window (which may cross midnight)."""
    if not window:
        return False
    start_s, end_s = (part.strip() for part in window.split("-"))
    start, end, t = dt.time.fromisoformat(start_s), dt.time.fromisoformat(end_s), now.time()
    return start <= t < end if start <= end else (t >= start or t < end)


def windows_toast(title: str, body: str) -> None:
    """Shows a Windows notification using the WinRT API built into Windows PowerShell."""
    script = (
        "[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] > $null;"
        "$t = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent("
        "[Windows.UI.Notifications.ToastTemplateType]::ToastText02);"
        "$x = $t.GetElementsByTagName('text');"
        "$x.Item(0).AppendChild($t.CreateTextNode($env:GNOSIS_TOAST_TITLE)) > $null;"
        "$x.Item(1).AppendChild($t.CreateTextNode($env:GNOSIS_TOAST_BODY)) > $null;"
        "$n = [Windows.UI.Notifications.ToastNotification]::new($t);"
        "[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier("
        "'{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe').Show($n)"
    )
    # Text goes in through environment variables, so nothing in it can be run as a command.
    env = {**os.environ, "GNOSIS_TOAST_TITLE": title[:120], "GNOSIS_TOAST_BODY": body[:400]}
    subprocess.run(["powershell", "-NoProfile", "-NonInteractive", "-Command", script],
                   env=env, check=True, capture_output=True, timeout=30)


def user_is_busy() -> bool:
    """True when Windows says the owner is in a full-screen game, presenting, or in Focus/quiet time."""
    if sys.platform != "win32":
        return False
    import ctypes

    state = ctypes.c_int(0)
    if ctypes.windll.shell32.SHQueryUserNotificationState(ctypes.byref(state)) != 0:
        return False
    # 2 busy (full-screen app), 3 Direct3D full-screen game, 4 presentation mode, 6 quiet time
    return state.value in (2, 3, 4, 6)


def idle_seconds() -> float:
    """Seconds since the last keyboard or mouse input on Windows (0 elsewhere)."""
    if sys.platform != "win32":
        return 0.0
    import ctypes

    class LASTINPUTINFO(ctypes.Structure):
        _fields_ = [("cbSize", ctypes.c_uint), ("dwTime", ctypes.c_uint)]

    info = LASTINPUTINFO(ctypes.sizeof(LASTINPUTINFO), 0)
    if not ctypes.windll.user32.GetLastInputInfo(ctypes.byref(info)):
        return 0.0
    return (ctypes.windll.kernel32.GetTickCount() - info.dwTime) / 1000.0


Speak = Callable[[str], Awaitable[None]]
Push = Callable[[str, str], Awaitable[int]]


class Notifier:
    def __init__(self, events: Any, audit: Any, config: dict[str, Any] | None = None,
                 clock: Callable[[], float] = time.time,
                 toast: Callable[[str, str], None] | None = None,
                 busy: Callable[[], bool] = user_is_busy, idle: Callable[[], float] = idle_seconds):
        cfg = config or {}
        self.events = events
        self.audit = audit
        self.clock = clock
        self.quiet_hours: str | None = cfg.get("quiet_hours", "23:00-07:00")
        self.max_per_hour = int(cfg.get("max_per_hour", 4))
        self.toast = toast if toast is not None else (windows_toast if sys.platform == "win32" else None)
        self.busy = busy
        self.idle = idle
        self.phone_push = cfg.get("phone_push", "away")  # away | always | never
        self.push: Push | None = None     # Set when the phone bridge is ready
        self.speakers: list[Speak] = []   # The voice loop adds itself here
        self.pending: list[Notice] = []   # Waiting for the next briefing
        self.dnd_until = 0.0
        self._recent: list[float] = []    # When non-urgent notices were last shown
        self._speaking: set[asyncio.Task] = set()

    def do_not_disturb(self, minutes: float) -> float:
        self.dnd_until = self.clock() + minutes * 60 if minutes > 0 else 0.0
        return self.dnd_until

    def decide(self, notice: Notice) -> list[str]:
        """The "should I speak?" step. Returns the channels to use: [] means saved for the briefing."""
        now = self.clock()
        quiet = (now < self.dnd_until or _in_window(self.quiet_hours, dt.datetime.fromtimestamp(now))
                 or self._safe_busy())
        if notice.urgency == "urgent":
            return [TOAST, SPEAK]
        if notice.urgency == "low":
            return []
        if notice.urgency == "high":
            return [TOAST] if quiet else [TOAST, SPEAK]
        self._recent = [t for t in self._recent if now - t < 3600]
        if quiet or len(self._recent) >= self.max_per_hour:
            return []
        return [TOAST]

    def _push_to_phone(self) -> bool:
        if self.phone_push == "always":
            return True
        if self.phone_push != "away":
            return False
        try:
            return self.idle() >= AWAY_AFTER_S
        except Exception:
            return False

    def _safe_busy(self) -> bool:
        try:
            return bool(self.busy())
        except Exception:
            return False

    async def notify(self, notice: Notice) -> list[str]:
        channels = self.decide(notice)
        if not channels:
            self.pending.append(notice)
        elif notice.urgency == "normal":
            self._recent.append(self.clock())
        if TOAST in channels and self.toast is not None:
            try:
                await asyncio.to_thread(self.toast, notice.title, notice.body)
            except Exception as e:
                self.audit.write("error", where="toast", error=f"{type(e).__name__}: {e}")
        if channels and self.push is not None and self._push_to_phone():
            try:
                if await self.push(notice.title, notice.body):
                    channels = [*channels, PHONE]
            except Exception as e:
                self.audit.write("error", where="phone_push", error=f"{type(e).__name__}: {e}")
        if SPEAK in channels:
            # Speaking waits until the owner isn't mid-sentence, so it mustn't hold up the caller.
            for speak in list(self.speakers):
                task = asyncio.create_task(self._speak(speak, notice.body))
                self._speaking.add(task)
                task.add_done_callback(self._speaking.discard)
        self.audit.write("notice", **notice.to_dict(), channels=channels or [QUEUE])
        await self.events.publish("notification", notice=notice.to_dict(), channels=channels or [QUEUE])
        return channels

    async def _speak(self, speak: Speak, text: str) -> None:
        try:
            await speak(text)
        except Exception as e:
            self.audit.write("error", where="speak_notice", error=f"{type(e).__name__}: {e}")

    async def drain(self) -> None:
        while self._speaking:
            await asyncio.gather(*list(self._speaking))
            await asyncio.sleep(0)

    def take_pending(self) -> list[Notice]:
        out, self.pending = self.pending, []
        return out


# ---- watchers -----------------------------------------------------------------

def battery_state() -> tuple[int, bool] | None:
    import psutil

    b = psutil.sensors_battery()
    return (round(b.percent), bool(b.power_plugged)) if b else None


def disk_free_percent() -> float:
    usage = shutil.disk_usage(os.environ.get("SystemDrive", "C:") + "\\" if sys.platform == "win32" else "/")
    return usage.free * 100 / usage.total


def pending_windows_updates() -> list[str]:
    """Titles of Windows updates that are available but not installed (can take a minute)."""
    script = ("$s = (New-Object -ComObject Microsoft.Update.Session).CreateUpdateSearcher();"
              "$s.Search('IsInstalled=0 and IsHidden=0').Updates | ForEach-Object { $_.Title }")
    out = subprocess.run(["powershell", "-NoProfile", "-NonInteractive", "-Command", script],
                         check=True, capture_output=True, text=True, timeout=600)
    return [line.strip() for line in out.stdout.splitlines() if line.strip()]


class Watchers:
    """Polls the laptop's state and raises a notice when something changes that you'd want to know."""

    def __init__(self, notifier: Notifier, config: dict[str, Any] | None = None,
                 battery: Callable[[], tuple[int, bool] | None] | None = battery_state,
                 disk: Callable[[], float] | None = disk_free_percent,
                 updates: Callable[[], list[str]] | None = None,
                 clock: Callable[[], float] = time.time):
        cfg = config or {}
        self.notifier = notifier
        self.battery = battery if cfg.get("battery", True) else None
        self.disk = disk if cfg.get("disk", True) else None
        if updates is None and sys.platform == "win32" and cfg.get("windows_update", True):
            updates = pending_windows_updates
        self.updates = updates
        self.updates_every_s = float(cfg.get("updates_every_h", 6)) * 3600
        self.clock = clock
        self.state: dict[str, Any] = {"battery": None, "disk_free_percent": None, "updates": None}
        self._battery_level = 0       # 0 fine, 1 warned at 20%, 2 warned at 10%
        self._disk_warned_day = None
        self._known_updates: set[str] = set()
        self._updates_checked = 0.0

    async def check(self) -> None:
        if self.battery:
            await self._check_battery()
        if self.disk:
            await self._check_disk()
        if self.updates and self.clock() - self._updates_checked >= self.updates_every_s:
            self._updates_checked = self.clock()
            await self._check_updates()

    async def _check_battery(self) -> None:
        reading = await asyncio.to_thread(self.battery)
        if reading is None:
            return
        percent, plugged = reading
        self.state["battery"] = {"percent": percent, "plugged_in": plugged}
        if plugged or percent > 25:
            self._battery_level = 0
            return
        if percent <= 10 and self._battery_level < 2:
            self._battery_level = 2
            await self.notifier.notify(Notice("Battery very low", f"Battery is at {percent}%. Plug in now.",
                                              "urgent", "battery"))
        elif percent <= 20 and self._battery_level < 1:
            self._battery_level = 1
            await self.notifier.notify(Notice("Battery low", f"Battery is at {percent}%. Plug in soon.",
                                              "high", "battery"))

    async def _check_disk(self) -> None:
        free = await asyncio.to_thread(self.disk)
        self.state["disk_free_percent"] = round(free, 1)
        today = dt.date.fromtimestamp(self.clock())
        if free < 10 and self._disk_warned_day != today:
            self._disk_warned_day = today
            await self.notifier.notify(Notice("Disk almost full", f"Only {free:.0f}% of your disk is free. "
                                              "Want me to find big files you could delete?", "normal", "disk"))

    async def _check_updates(self) -> None:
        try:
            titles = await asyncio.to_thread(self.updates)
        except Exception as e:
            self.notifier.audit.write("error", where="windows_update", error=f"{type(e).__name__}: {e}")
            return
        self.state["updates"] = titles
        new = [t for t in titles if t not in self._known_updates]
        self._known_updates = set(titles)
        if new:
            names = "; ".join(new[:3]) + (f" and {len(new) - 3} more" if len(new) > 3 else "")
            await self.notifier.notify(Notice(
                "Windows updates ready",
                f"{len(new)} Windows update{'s are' if len(new) > 1 else ' is'} ready: {names}. "
                "Want me to open Windows Update?", "normal", "windows_update"))

    async def run(self, every_s: float = 60.0) -> None:
        while True:
            try:
                await self.check()
            except Exception as e:
                self.notifier.audit.write("error", where="watchers", error=f"{type(e).__name__}: {e}")
            await asyncio.sleep(every_s)
