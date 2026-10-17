"""Gnosis's tray icon, drawn in code so there's no image file to lose: a ring with a bright core."""

from __future__ import annotations


def icon_image(size: int = 64):
    from PIL import Image, ImageDraw

    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    pad = size // 16
    d.ellipse((pad, pad, size - pad, size - pad), fill=(11, 15, 20, 255), outline=(76, 201, 240, 255),
              width=max(2, size // 12))
    c, r = size // 2, size // 6
    d.ellipse((c - r, c - r, c + r, c + r), fill=(76, 201, 240, 255))
    return img
