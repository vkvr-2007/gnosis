"""Gnosis's icon, drawn in code so there's no image file to lose: a ring with a bright core."""

from __future__ import annotations

from pathlib import Path


def icon_image(size: int = 64):
    from PIL import Image, ImageDraw

    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    pad = size // 16
    d.ellipse((pad, pad, size - pad, size - pad), fill=(13, 17, 23, 255), outline=(88, 166, 255, 255),
              width=max(2, size // 12))
    c = size // 2
    r = size // 6
    d.ellipse((c - r, c - r, c + r, c + r), fill=(121, 192, 255, 255))
    return img


def write_ico(path: Path) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    icon_image(256).save(path, format="ICO", sizes=[(16, 16), (32, 32), (48, 48), (64, 64), (256, 256)])
    return path
