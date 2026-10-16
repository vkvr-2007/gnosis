"""Small built-in tools that work on any OS. Desktop, phone and coder skills arrive in later build steps."""

from __future__ import annotations

import datetime as dt
import os
import platform
from pathlib import Path

from gnosis.core.tools import ToolRegistry

_MAX_READ_BYTES = 20_000


def register_builtin(registry: ToolRegistry) -> None:
    @registry.tool("get_time", "Get the current local date, time and timezone.")
    def get_time() -> str:
        now = dt.datetime.now().astimezone()
        return now.strftime("%A %d %B %Y, %H:%M (%Z)")

    @registry.tool("system_info", "Get basic facts about this computer: OS, CPU cores and battery.")
    def system_info() -> dict:
        info = {
            "os": f"{platform.system()} {platform.release()}",
            "machine": platform.machine(),
            "cpu_cores": os.cpu_count(),
        }
        try:
            import psutil  # Optional; installed on Windows builds.
            battery = psutil.sensors_battery()
            if battery:
                info["battery_percent"] = round(battery.percent)
                info["plugged_in"] = battery.power_plugged
        except ImportError:
            pass
        return info

    @registry.tool(
        "read_file",
        "Read a text file from the user's allowed folders.",
        {
            "type": "object",
            "properties": {"path": {"type": "string", "description": "Path to the file"}},
            "required": ["path"],
        },
        tags=("local_files",),
    )
    def read_file(path: str) -> str:
        p = Path(path).expanduser()
        data = p.read_bytes()[:_MAX_READ_BYTES]
        text = data.decode("utf-8", errors="replace")
        if p.stat().st_size > _MAX_READ_BYTES:
            text += f"\n[... truncated, file is {p.stat().st_size} bytes]"
        return text
