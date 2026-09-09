#!/usr/bin/env python3
"""Generate the NInfer Studio iconset from scratch (no external assets).

Draws a rounded gradient tile (indigo -> violet) with a white chat bubble and
three accent typing dots, then emits the sizes Tauri's bundler expects:
  32x32.png, 128x128.png, 128x128@2x.png (256), icon.png (512), icon.ico.
"""
from PIL import Image, ImageDraw

SIZES = [32, 128, 256, 512]


def make_icon(size: int) -> Image.Image:
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)

    top = (99, 102, 241)   # indigo-500
    bot = (168, 85, 247)   # purple-500
    for y in range(size):
        t = y / (size - 1)
        r = int(top[0] + (bot[0] - top[0]) * t)
        g = int(top[1] + (bot[1] - top[1]) * t)
        b = int(top[2] + (bot[2] - top[2]) * t)
        d.line([(0, y), (size, y)], fill=(r, g, b, 255))

    # round the tile corners
    m = max(1, int(size * 0.06))
    radius = int(size * 0.22)
    mask = Image.new("L", (size, size), 0)
    ImageDraw.Draw(mask).rounded_rectangle(
        [m, m, size - m, size - m], radius=radius, fill=255
    )
    img.putalpha(mask)

    d = ImageDraw.Draw(img)
    # chat bubble
    bw, bh = int(size * 0.60), int(size * 0.46)
    bx0 = (size - bw) // 2
    by0 = int(size * 0.24)
    bx1, by1 = bx0 + bw, by0 + bh
    br = int(size * 0.16)
    d.rounded_rectangle([bx0, by0, bx1, by1], radius=br, fill=(255, 255, 255, 255))

    # typing dots (accent)
    dotc = (168, 85, 247, 255)
    n = 3
    gap = int(size * 0.07)
    dr = int(size * 0.045)
    total = gap * (n - 1) + 2 * dr * n
    startx = (size - total) // 2 + dr
    cy = by0 + bh // 2
    for i in range(n):
        cx = startx + i * (2 * dr + gap)
        d.ellipse([cx - dr, cy - dr, cx + dr, cy + dr], fill=dotc)
    return img


imgs = {s: make_icon(s) for s in SIZES}
names = {32: "32x32.png", 128: "128x128.png", 256: "128x128@2x.png", 512: "icon.png"}
for s, fn in names.items():
    imgs[s].save(f"desktop/app/icons/{fn}")
imgs[512].save("desktop/app/icons/icon.ico", sizes=[(32, 32), (128, 128), (256, 256)])
print("generated:", ", ".join(names.values()), "icon.ico")
