"""Controls the owner's Android phone over ADB (wireless debugging, paired once).

Everything goes through the `adb` program from Android's platform-tools; `scripts/get_adb.ps1`
downloads it. Calls are plain intents. Sending a message opens the chat with the text filled in and
then taps Send, found by reading the phone's screen with `uiautomator dump`.
"""

from __future__ import annotations

import json
import os
import re
import shlex
import shutil
import subprocess
import time
import urllib.parse
import xml.etree.ElementTree as ET
from dataclasses import dataclass
from pathlib import Path
from typing import Callable

Runner = Callable[[list[str], float], str]  # (adb arguments, timeout) -> stdout

APP_ALIASES = {
    "whatsapp": "com.whatsapp", "youtube": "com.google.android.youtube", "spotify": "com.spotify.music",
    "instagram": "com.instagram.android", "chrome": "com.android.chrome", "maps": "com.google.android.apps.maps",
    "gmail": "com.google.android.gm", "camera": "com.android.camera", "settings": "com.android.settings",
    "phone": "com.google.android.dialer", "messages": "com.google.android.apps.messaging",
    "photos": "com.google.android.apps.photos", "telegram": "org.telegram.messenger",
    "calendar": "com.google.android.calendar", "clock": "com.google.android.deskclock",
}


class AdbError(RuntimeError):
    pass


def find_adb(data_dir: Path | None = None) -> str | None:
    candidates = [shutil.which("adb")]
    if data_dir is not None:
        candidates.append(str(data_dir / "platform-tools" / ("adb.exe" if os.name == "nt" else "adb")))
    return next((c for c in candidates if c and Path(c).exists()), None)


def subprocess_runner(adb_path: str) -> Runner:
    def run(args: list[str], timeout: float) -> str:
        out = subprocess.run([adb_path, *args], capture_output=True, text=True, timeout=timeout,
                             encoding="utf-8", errors="replace")
        if out.returncode != 0:
            raise AdbError((out.stderr or out.stdout).strip() or f"adb {args[0]} failed")
        return out.stdout
    return run


def normalize_number(number: str) -> str:
    keep = re.sub(r"[^\d+]", "", number)
    if not re.fullmatch(r"\+?\d{3,15}", keep):
        raise ValueError(f"'{number}' doesn't look like a phone number")
    return keep


@dataclass
class UINode:
    text: str
    desc: str
    resource_id: str
    bounds: tuple[int, int, int, int]

    @property
    def center(self) -> tuple[int, int]:
        l, t, r, b = self.bounds
        return (l + r) // 2, (t + b) // 2


def parse_ui_dump(xml: str) -> list[UINode]:
    nodes = []
    root = ET.fromstring(xml[xml.find("<"):])
    for n in root.iter("node"):
        m = re.match(r"\[(\d+),(\d+)\]\[(\d+),(\d+)\]", n.get("bounds", ""))
        if not m:
            continue
        nodes.append(UINode(n.get("text", ""), n.get("content-desc", ""), n.get("resource-id", ""),
                            tuple(int(x) for x in m.groups())))
    return nodes


def parse_notifications(dump: str) -> list[dict]:
    """Pulls app, title and text out of `dumpsys notification --noredact`."""
    out, current = [], None
    for line in dump.splitlines():
        line = line.strip()
        m = re.match(r"NotificationRecord\(.*?pkg=(\S+)", line)
        if m:
            current = {"app": m.group(1), "title": "", "text": ""}
            out.append(current)
            continue
        if current is None:
            continue
        m = re.match(r"android\.(title|text)=\S+ \((.*)\)$", line) or re.match(r"android\.(title|text)=(.*)$", line)
        if m and not current[m.group(1)]:
            current[m.group(1)] = m.group(2).strip()
    seen, result = set(), []
    for n in out:
        key = (n["app"], n["title"], n["text"])
        if (n["title"] or n["text"]) and key not in seen and n["app"] != "android":
            seen.add(key)
            result.append(n)
    return result


def parse_contacts(rows: str) -> list[tuple[str, str]]:
    """Reads `content query` output: 'Row: 0 display_name=Mom, data1=+91 98xxxx'."""
    out = []
    for line in rows.splitlines():
        m = re.search(r"display_name=(.*?), data1=(.*)$", line.strip())
        if m and m.group(1) and m.group(1) != "NULL":
            try:
                out.append((m.group(1).strip(), normalize_number(m.group(2))))
            except ValueError:
                continue
    return out


class Phone:
    def __init__(self, run: Runner | None, state_path: Path | None = None):
        self._run = run
        self.state_path = state_path

    @property
    def installed(self) -> bool:
        return self._run is not None

    def adb(self, *args: str, timeout: float = 20) -> str:
        if self._run is None:
            raise AdbError("adb isn't installed. Run scripts\\get_adb.ps1, then `python -m gnosis phone pair`.")
        return self._run(list(args), timeout)

    def shell(self, command: str, timeout: float = 20) -> str:
        return self.adb("shell", command, timeout=timeout)

    # ---- connection ----------------------------------------------------------

    def devices(self) -> list[str]:
        lines = self.adb("devices").splitlines()[1:]
        return [l.split()[0] for l in lines if l.strip().endswith("device")]

    def pair(self, address: str, code: str) -> str:
        return self.adb("pair", address, code, timeout=30).strip()

    def connect(self, address: str | None = None) -> str:
        address = address or self._saved_address()
        if not address:
            raise AdbError("No phone address saved yet. Pair first with `python -m gnosis phone pair`.")
        out = self.adb("connect", address, timeout=15).strip()
        if "connected" not in out or "cannot" in out or "failed" in out:
            raise AdbError(out or "couldn't connect")
        self._save_address(address)
        return out

    def ensure_connected(self) -> None:
        if self.devices():
            return
        try:
            self.connect()
        except AdbError as e:
            raise AdbError(f"Your phone isn't connected ({e}). Check that wireless debugging is on and the phone "
                           "is on the same network (or Tailscale).") from None
        if not self.devices():
            raise AdbError("Your phone isn't connected. Check that wireless debugging is on.")

    def _saved_address(self) -> str | None:
        if self.state_path and self.state_path.exists():
            return json.loads(self.state_path.read_text()).get("address")
        return None

    def _save_address(self, address: str) -> None:
        if self.state_path:
            self.state_path.write_text(json.dumps({"address": address}))

    # ---- actions ----------------------------------------------------------------

    def status(self) -> dict:
        self.ensure_connected()
        battery = self.shell("dumpsys battery")
        level = re.search(r"level: (\d+)", battery)
        model = self.shell("getprop ro.product.model").strip()
        return {"connected": True, "model": model, "battery_percent": int(level.group(1)) if level else None}

    def call(self, number: str) -> str:
        self.ensure_connected()
        number = normalize_number(number)
        self.shell(f"am start -a android.intent.action.CALL -d {shlex.quote('tel:' + number)}")
        return f"Calling {number}"

    def end_call(self) -> str:
        self.ensure_connected()
        self.shell("input keyevent KEYCODE_ENDCALL")
        return "Hung up"

    def screen(self) -> list[UINode]:
        self.shell("uiautomator dump /sdcard/gnosis_ui.xml", timeout=30)
        return parse_ui_dump(self.shell("cat /sdcard/gnosis_ui.xml"))

    def tap(self, x: int, y: int) -> None:
        self.shell(f"input tap {int(x)} {int(y)}")

    def tap_send(self, ids: tuple[str, ...] = (), wait_s: float = 8.0) -> bool:
        """Finds and taps the Send button on the phone's screen."""
        deadline = time.monotonic() + wait_s
        while time.monotonic() < deadline:
            for node in self.screen():
                label = f"{node.text} {node.desc}".strip().lower()
                if any(node.resource_id.endswith(i) for i in ids) or label in ("send", "send message", "send sms"):
                    self.tap(*node.center)
                    return True
            time.sleep(1.0)
        return False

    def send_sms(self, number: str, text: str) -> str:
        self.ensure_connected()
        number = normalize_number(number)
        self.shell("am start -a android.intent.action.SENDTO -d " + shlex.quote("sms:" + number)
                   + " --es sms_body " + shlex.quote(text) + " --ez exit_on_sent true")
        time.sleep(1.5)
        if not self.tap_send(("send_message_button_icon", "send_button")):
            return "Opened the message with your text, but I couldn't find the Send button. It's ready on your phone."
        return f"Sent the SMS to {number}"

    def send_whatsapp(self, number: str, text: str) -> str:
        self.ensure_connected()
        number = normalize_number(number).lstrip("+")
        url = f"https://wa.me/{number}?text={urllib.parse.quote(text)}"
        self.shell("am start -a android.intent.action.VIEW -p com.whatsapp -d " + shlex.quote(url))
        time.sleep(2.5)
        if not self.tap_send(("com.whatsapp:id/send",)):
            return "Opened the WhatsApp chat with your text, but I couldn't find Send. It's ready on your phone."
        return f"Sent the WhatsApp message to +{number}"

    def packages(self) -> list[str]:
        return [l.removeprefix("package:").strip() for l in self.shell("pm list packages -3").splitlines()
                if l.startswith("package:")]

    def open_app(self, name: str) -> str:
        self.ensure_connected()
        key = name.strip().lower()
        package = APP_ALIASES.get(key)
        if package is None:
            words = [w for w in re.split(r"\W+", key) if w]
            package = next((p for p in self.packages() if all(w in p.lower() for w in words)), None)
        if package is None:
            raise AdbError(f"I couldn't find an app called '{name}' on your phone")
        self.shell(f"monkey -p {shlex.quote(package)} -c android.intent.category.LAUNCHER 1")
        return f"Opened {package}"

    def notifications(self) -> list[dict]:
        self.ensure_connected()
        return parse_notifications(self.shell("dumpsys notification --noredact", timeout=30))

    def contacts(self) -> list[tuple[str, str]]:
        self.ensure_connected()
        rows = self.shell("content query --uri content://com.android.contacts/data/phones "
                          "--projection display_name:data1", timeout=60)
        return parse_contacts(rows)
