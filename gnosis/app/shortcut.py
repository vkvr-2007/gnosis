"""Adds Gnosis to the Windows Start menu (and optionally the desktop), pointing at this copy of the code."""

from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path

from gnosis.app.icon import write_ico
from gnosis.identity import REPO_ROOT


def _pythonw() -> Path:
    exe = Path(sys.executable)
    windowed = exe.with_name("pythonw.exe")
    return windowed if windowed.exists() else exe  # pythonw has no console window


def _quote(value: str) -> str:
    return "'" + value.replace("'", "''") + "'"  # PowerShell single-quoted string


def install(data_dir: Path, name: str = "Gnosis", desktop: bool = False) -> list[Path]:
    if sys.platform != "win32":
        raise RuntimeError("Shortcuts are only made on Windows.")
    icon = write_ico(data_dir / "gnosis.ico")
    places = [Path(os.environ["APPDATA"]) / "Microsoft" / "Windows" / "Start Menu" / "Programs"]
    if desktop:
        places.append(Path(os.environ["USERPROFILE"]) / "Desktop")
    made = []
    for folder in places:
        link = folder / f"{name}.lnk"
        script = "; ".join([
            "$s = (New-Object -ComObject WScript.Shell).CreateShortcut(" + _quote(str(link)) + ")",
            "$s.TargetPath = " + _quote(str(_pythonw())),
            "$s.Arguments = '-m gnosis'",
            "$s.WorkingDirectory = " + _quote(str(REPO_ROOT)),
            "$s.IconLocation = " + _quote(str(icon)),
            "$s.Description = " + _quote(f"{name}, your desktop assistant"),
            "$s.Save()",
        ])
        subprocess.run(["powershell", "-NoProfile", "-NonInteractive", "-Command", script], check=True)
        made.append(link)
    return made
