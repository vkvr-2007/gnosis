"""Adds Gnosis to the Windows Start menu (and optionally the desktop), pointing at this copy of the code."""

from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path

from gnosis.config import REPO_ROOT
from gnosis.window.icon import icon_image


def write_ico(path: Path) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    icon_image(256).save(path, format="ICO", sizes=[(16, 16), (32, 32), (48, 48), (64, 64), (256, 256)])
    return path


def pythonw() -> Path:
    exe = Path(sys.executable)
    windowed = exe.with_name("pythonw.exe")
    return windowed if windowed.exists() else exe  # pythonw opens no console window


def _quote(value: str) -> str:
    return "'" + value.replace("'", "''") + "'"  # A PowerShell single-quoted string


def shortcut_script(link: Path, icon: Path, voice: bool, name: str = "Gnosis") -> str:
    return "; ".join([
        "$s = (New-Object -ComObject WScript.Shell).CreateShortcut(" + _quote(str(link)) + ")",
        "$s.TargetPath = " + _quote(str(pythonw())),
        "$s.Arguments = " + _quote("-m gnosis app" + (" --voice" if voice else "")),
        "$s.WorkingDirectory = " + _quote(str(REPO_ROOT)),
        "$s.IconLocation = " + _quote(str(icon)),
        "$s.Description = " + _quote(f"{name}, your desktop assistant"),
        "$s.Save()",
    ])


def install(data_dir: Path, voice: bool = True, desktop: bool = False, name: str = "Gnosis") -> list[Path]:
    if sys.platform != "win32":
        raise RuntimeError("Shortcuts are only made on Windows.")
    icon = write_ico(data_dir / "gnosis.ico")
    places = [Path(os.environ["APPDATA"]) / "Microsoft" / "Windows" / "Start Menu" / "Programs"]
    if desktop:
        places.append(Path(os.environ["USERPROFILE"]) / "Desktop")
    made = []
    for folder in places:
        link = folder / f"{name}.lnk"
        subprocess.run(["powershell", "-NoProfile", "-NonInteractive", "-Command",
                        shortcut_script(link, icon, voice, name)], check=True, capture_output=True)
        made.append(link)
    return made
