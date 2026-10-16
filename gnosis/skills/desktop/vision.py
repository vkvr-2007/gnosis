"""Screenshot fallback: when an app doesn't expose its controls, Gnosis looks at the screen.

The screenshot is overlaid with numbered boxes ("set-of-marks"), one per control found, or a grid when
there are none (games, canvases). The vision model picks a number, and Gnosis clicks its centre.
"""

from __future__ import annotations

import base64
import io
import re
from dataclasses import dataclass
from typing import Any

from PIL import Image, ImageDraw, ImageFont

MAX_WIDTH = 1280


@dataclass
class Mark:
    id: int
    rect: tuple[int, int, int, int]  # Screen pixels

    @property
    def center(self) -> tuple[int, int]:
        l, t, r, b = self.rect
        return (l + r) // 2, (t + b) // 2


def capture(rect: tuple[int, int, int, int] | None = None) -> tuple[Image.Image, tuple[int, int]]:
    """Screenshot of `rect` (screen pixels) or the primary monitor. Returns the image and its top-left."""
    import mss

    with mss.mss() as sct:
        mon = sct.monitors[1]
        if rect:
            l, t, r, b = rect
            mon = {"left": l, "top": t, "width": max(r - l, 1), "height": max(b - t, 1)}
        shot = sct.grab(mon)
        return Image.frombytes("RGB", shot.size, shot.rgb), (mon["left"], mon["top"])


def grid_marks(origin: tuple[int, int], size: tuple[int, int], cols: int = 12, rows: int = 8) -> list[Mark]:
    ox, oy = origin
    w, h = size
    marks = []
    for r in range(rows):
        for c in range(cols):
            l, t = ox + c * w // cols, oy + r * h // rows
            marks.append(Mark(len(marks) + 1, (l, t, ox + (c + 1) * w // cols, oy + (r + 1) * h // rows)))
    return marks


def draw_marks(img: Image.Image, origin: tuple[int, int], marks: list[Mark]) -> Image.Image:
    """Returns a (possibly downscaled) copy of the screenshot with numbered boxes drawn on it."""
    out = img.copy()
    draw = ImageDraw.Draw(out)
    try:
        font = ImageFont.truetype("arial.ttf", 14)
    except OSError:
        font = ImageFont.load_default()
    ox, oy = origin
    for m in marks:
        l, t, r, b = (m.rect[0] - ox, m.rect[1] - oy, m.rect[2] - ox, m.rect[3] - oy)
        draw.rectangle((l, t, r, b), outline=(255, 0, 80), width=2)
        label = str(m.id)
        tw = draw.textlength(label, font=font)
        draw.rectangle((l, t, l + tw + 6, t + 17), fill=(255, 0, 80))
        draw.text((l + 3, t + 1), label, fill=(255, 255, 255), font=font)
    if out.width > MAX_WIDTH:
        out = out.resize((MAX_WIDTH, round(out.height * MAX_WIDTH / out.width)))
    return out


def to_data_url(img: Image.Image) -> str:
    buf = io.BytesIO()
    img.save(buf, format="JPEG", quality=80)
    return "data:image/jpeg;base64," + base64.b64encode(buf.getvalue()).decode()


def parse_mark(text: str, max_id: int) -> int | None:
    m = re.search(r"\d+", text or "")
    if not m:
        return None
    n = int(m.group(0))
    return n if 1 <= n <= max_id else None


async def pick_mark(llm: Any, img: Image.Image, marks: list[Mark], target: str,
                    tags: set[str]) -> Mark | None:
    prompt = (f"This is a screenshot with numbered red boxes. Which box is: {target}?\n"
              "Reply with only the box number, or 0 if none of them match.")
    result = await llm.chat("vision", [{"role": "user", "content": [
        {"type": "text", "text": prompt},
        {"type": "image_url", "image_url": {"url": to_data_url(img)}},
    ]}], tags=tags, temperature=0)
    n = parse_mark(result.message.content or "", len(marks))
    return marks[n - 1] if n else None


async def ask_about(llm: Any, img: Image.Image, question: str, tags: set[str]) -> str:
    if img.width > MAX_WIDTH:
        img = img.resize((MAX_WIDTH, round(img.height * MAX_WIDTH / img.width)))
    result = await llm.chat("vision", [{"role": "user", "content": [
        {"type": "text", "text": question},
        {"type": "image_url", "image_url": {"url": to_data_url(img)}},
    ]}], tags=tags, temperature=0.2)
    return (result.message.content or "").strip()
