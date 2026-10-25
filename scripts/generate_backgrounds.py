#!/usr/bin/env python3
"""Generate CAREer Studio's original soft-focus office backdrops.

Every backdrop is drawn procedurally from simple shapes (walls, windows,
shelves, plants, lamps) and then defocused, so the artwork is original and
free of third-party licensing. Re-run any time:

    python3 scripts/generate_backgrounds.py

Requires: numpy, opencv-python, Pillow. Output: public/backgrounds/*.jpg
(2400x2400) plus 320px thumbnails, and public/backgrounds/manifest.json.
"""
import json
import math
import os

import cv2
import numpy as np
from PIL import Image

SIZE = 2400
OUT = os.path.join(os.path.dirname(__file__), "..", "public", "backgrounds")
THUMBS = os.path.join(OUT, "thumbs")


def hex_rgb(h):
    h = h.lstrip("#")
    return np.array([int(h[i:i + 2], 16) for i in (0, 2, 4)], dtype=np.float32)


def vgrad(top, bottom, h=SIZE, w=SIZE):
    t = np.linspace(0, 1, h, dtype=np.float32)[:, None, None]
    return (hex_rgb(top) * (1 - t) + hex_rgb(bottom) * t) * np.ones((h, w, 1), np.float32)


def _clip(img, x0, y0, x1, y1):
    h, w = img.shape[:2]
    return (max(0, min(w, int(round(x0)))), max(0, min(h, int(round(y0)))),
            max(0, min(w, int(round(x1)))), max(0, min(h, int(round(y1)))))


def rect(img, x0, y0, x1, y1, color, alpha=1.0):
    x0, y0, x1, y1 = _clip(img, x0, y0, x1, y1)
    if x1 <= x0 or y1 <= y0:
        return
    c = hex_rgb(color) if isinstance(color, str) else np.asarray(color, np.float32)
    img[y0:y1, x0:x1] = img[y0:y1, x0:x1] * (1 - alpha) + c * alpha


def grad_rect(img, x0, y0, x1, y1, top, bottom, alpha=1.0):
    x0, y0, x1, y1 = _clip(img, x0, y0, x1, y1)
    if x1 <= x0 or y1 <= y0:
        return
    g = vgrad(top, bottom, y1 - y0, x1 - x0)
    img[y0:y1, x0:x1] = img[y0:y1, x0:x1] * (1 - alpha) + g * alpha


def disc(img, cx, cy, r, color, alpha=1.0, soft=0.0):
    h, w = img.shape[:2]
    x0, x1 = max(0, int(cx - r - 2)), min(w, int(cx + r + 2))
    y0, y1 = max(0, int(cy - r - 2)), min(h, int(cy + r + 2))
    if x1 <= x0 or y1 <= y0:
        return
    yy, xx = np.mgrid[y0:y1, x0:x1].astype(np.float32)
    d = np.sqrt((xx - cx) ** 2 + (yy - cy) ** 2)
    edge = max(1.5, soft * r)
    a = np.clip((r - d) / edge, 0, 1)[..., None] * alpha
    c = hex_rgb(color) if isinstance(color, str) else np.asarray(color, np.float32)
    img[y0:y1, x0:x1] = img[y0:y1, x0:x1] * (1 - a) + c * a


def window(img, x0, y0, x1, y1, sky_top, sky_bottom, frame, cols=3, rows=2, bar=18, city=None, rng=None):
    grad_rect(img, x0, y0, x1, y1, sky_top, sky_bottom)
    if city:
        # distant buildings: soft blocks near the bottom of the glass
        x = x0
        while x < x1:
            bw = rng.uniform(60, 180)
            bh = rng.uniform(0.15, 0.55) * (y1 - y0)
            rect(img, x, y1 - bh, min(x1, x + bw), y1, city, alpha=rng.uniform(0.35, 0.65))
            x += bw + rng.uniform(10, 50)
    for i in range(1, cols):
        x = x0 + (x1 - x0) * i / cols
        rect(img, x - bar / 2, y0, x + bar / 2, y1, frame)
    for j in range(1, rows):
        y = y0 + (y1 - y0) * j / rows
        rect(img, x0, y - bar / 2, x1, y + bar / 2, frame)
    rect(img, x0 - bar, y0 - bar, x1 + bar, y0, frame)
    rect(img, x0 - bar, y1, x1 + bar, y1 + bar, frame)
    rect(img, x0 - bar, y0, x0, y1, frame)
    rect(img, x1, y0, x1 + bar, y1, frame)


def shelves(img, x0, y0, x1, y1, board, book_palette, rng, levels=4):
    step = (y1 - y0) / levels
    for k in range(levels):
        top = y0 + k * step
        rect(img, x0, top + step - 16, x1, top + step, board)
        x = x0 + 10
        while x < x1 - 40:
            bw = rng.uniform(22, 60)
            bh = rng.uniform(0.45, 0.85) * (step - 30)
            if rng.random() < 0.18:
                x += rng.uniform(40, 140)  # gap / ornament space
                continue
            rect(img, x, top + step - 16 - bh, x + bw, top + step - 16, rng.choice(book_palette))
            x += bw + rng.uniform(2, 8)


def plant(img, cx, base_y, height, rng, leaf="#5d7258", leaf2="#7d8f70", pot="#c9b8a6"):
    rect(img, cx - height * 0.16, base_y - height * 0.22, cx + height * 0.16, base_y, pot)
    for _ in range(46):
        ang = rng.uniform(-math.pi * 0.95, -math.pi * 0.05)
        dist = rng.uniform(0.15, 1.0) * height * 0.75
        lx = cx + math.cos(ang) * dist
        ly = base_y - height * 0.22 + math.sin(ang) * dist
        disc(img, lx, ly, rng.uniform(0.05, 0.11) * height, leaf if rng.random() < 0.6 else leaf2, alpha=0.95)


def lamp_glow(img, cx, cy, r, color, alpha=0.9):
    disc(img, cx, cy, r, color, alpha=alpha, soft=0.9)


def defocus(img, sigma):
    out = cv2.GaussianBlur(img, (0, 0), sigmaX=sigma, sigmaY=sigma)
    return out


def bokeh(img, rng, count, rmin, rmax, colors, alpha=(0.25, 0.55), region=None):
    h, w = img.shape[:2]
    x0, y0, x1, y1 = region or (0, 0, w, h)
    for _ in range(count):
        cx, cy = rng.uniform(x0, x1), rng.uniform(y0, y1)
        r = rng.uniform(rmin, rmax)
        a = rng.uniform(*alpha)
        c = rng.choice(colors)
        # screen-blend a soft-edged disc so highlights stay luminous
        tmp = img.copy()
        disc(tmp, cx, cy, r, c, alpha=1.0, soft=0.18)
        img[:] = img + (np.maximum(tmp, img) - img) * a


def finish(img, rng, vignette=0.18, grain=2.2):
    h, w = img.shape[:2]
    yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)
    d = np.sqrt(((xx - w / 2) / (w / 2)) ** 2 + ((yy - h / 2) / (h / 2)) ** 2)
    img *= (1 - vignette * np.clip(d - 0.35, 0, 1) ** 1.6)[..., None]
    img += rng.normal(0, grain, img.shape).astype(np.float32)
    return np.clip(img, 0, 255).astype(np.uint8)


# ---------------------------------------------------------------- scenes
def glass_office(rng):
    img = vgrad("#e9e4de", "#cfc7bf")
    window(img, 900, 260, 2400, 1700, "#f4f6f7", "#dfe6ea", "#8c8f93", cols=4, rows=1, bar=26, city="#b8c2c9", rng=rng)
    rect(img, 0, 1700, 2400, 2400, "#bdb2a7")
    rect(img, 0, 1640, 2400, 1700, "#a99d92")
    for x in (260, 560):  # glass partition edges
        rect(img, x, 200, x + 14, 1700, "#f6f4f1", alpha=0.7)
    plant(img, 420, 1700, 820, rng)
    img = defocus(img, 36)
    bokeh(img, rng, 26, 30, 80, ["#fffaf2", "#fff3e0"], region=(900, 250, 2400, 1100))
    return finish(img, rng)


def warm_library(rng):
    img = vgrad("#8a6a55", "#5c4536")
    shelves(img, 0, 140, 2400, 1900, "#4a3428",
            ["#7d3f35", "#a6763f", "#3f4c5a", "#c9b18a", "#5e6e4f", "#8c5a3c", "#d8c7a8"], rng, levels=5)
    rect(img, 0, 1900, 2400, 2400, "#3f2e25")
    for cx in (520, 1880):
        lamp_glow(img, cx, 560, 120, "#ffd9a0", alpha=0.85)
    img = defocus(img, 30)
    bokeh(img, rng, 34, 25, 70, ["#ffd8a8", "#ffe7c4", "#f4b77a"], region=(0, 100, 2400, 1700))
    return finish(img, rng, vignette=0.28)


def open_plan(rng):
    img = vgrad("#f2efe9", "#dcd6cd")
    window(img, -40, 200, 2440, 1300, "#fbfbf8", "#eef0ee", "#d6d2cc", cols=6, rows=1, bar=20, rng=rng)
    rect(img, 0, 1300, 2400, 2400, "#cfc6bb")
    for i in range(7):  # desks & monitors
        x = 120 + i * 330
        rect(img, x, 1450, x + 260, 1490, "#e9e4dd")
        rect(img, x + 60, 1300, x + 200, 1420, "#2f3133")
        rect(img, x + 120, 1420, x + 140, 1450, "#2f3133")
    for cx in (300, 1250, 2150):
        plant(img, cx, 1460, 520, rng, leaf="#5e7d55", leaf2="#7f9a6c")
    img = defocus(img, 34)
    bokeh(img, rng, 18, 30, 70, ["#ffffff"], alpha=(0.2, 0.4), region=(0, 150, 2400, 1000))
    return finish(img, rng, vignette=0.12)


def city_dusk(rng):
    img = vgrad("#3d4a64", "#2a2f3f")
    window(img, 120, 120, 2280, 1800, "#7f8fb0", "#e8b48f", "#22252c", cols=3, rows=1, bar=34, city="#2b3245", rng=rng)
    # lit windows in the skyline
    for _ in range(220):
        x, y = rng.uniform(140, 2260), rng.uniform(1100, 1780)
        rect(img, x, y, x + 10, y + 14, "#ffd38a", alpha=rng.uniform(0.4, 0.9))
    rect(img, 0, 1800, 2400, 2400, "#20232a")
    img = defocus(img, 22)
    bokeh(img, rng, 60, 18, 60, ["#ffcf8a", "#ffe2b0", "#f6a96b"], alpha=(0.35, 0.7), region=(120, 1000, 2280, 1800))
    return finish(img, rng, vignette=0.3)


def boardroom_grey(rng):
    img = vgrad("#b9bcbf", "#8e9296")
    rect(img, 0, 1500, 2400, 2400, "#5f5a55")
    for x in range(0, 2400, 300):  # wall panels
        rect(img, x, 0, x + 6, 1500, "#a7aaad")
    rect(img, 700, 380, 1700, 980, "#2c2f33")  # wall screen
    rect(img, 300, 1420, 2100, 1520, "#3b3632")  # table edge
    lamp_glow(img, 1200, 120, 260, "#f6f3ee", alpha=0.6)
    img = defocus(img, 30)
    return finish(img, rng, vignette=0.22)


def studio_cream(rng):
    img = vgrad("#f6eee6", "#e2d3c4")
    disc(img, 1200, 900, 1300, "#fbf6f0", alpha=0.75, soft=1.0)
    img = defocus(img, 40)
    return finish(img, rng, vignette=0.2, grain=1.6)


def plants_light(rng):
    img = vgrad("#ece6dc", "#d7cdbf")
    window(img, 1300, 0, 2400, 1500, "#fbfaf4", "#f1efe4", "#e5e0d6", cols=2, rows=2, bar=22, rng=rng)
    rect(img, 0, 1600, 2400, 2400, "#c8b9a6")
    plant(img, 1550, 1650, 1100, rng, leaf="#4c6a45", leaf2="#6f8e5e")
    plant(img, 2250, 1650, 800, rng, leaf="#57744b", leaf2="#82a06d")
    plant(img, 300, 1650, 650, rng, leaf="#58704f", leaf2="#7c946a", pot="#e7ddd2")
    img = defocus(img, 38)
    bokeh(img, rng, 20, 30, 80, ["#fffdf5"], alpha=(0.25, 0.5), region=(1300, 0, 2400, 1300))
    return finish(img, rng, vignette=0.14)


def executive_navy(rng):
    img = vgrad("#2c3a52", "#1d2638")
    shelves(img, 1500, 300, 2400, 1700, "#1a2130", ["#8a6a45", "#c7b28c", "#5a2f35", "#3d5068", "#a58a63"], rng, levels=4)
    rect(img, 0, 1700, 2400, 2400, "#161c28")
    lamp_glow(img, 400, 900, 180, "#ffdca8", alpha=0.85)
    rect(img, 380, 1080, 420, 1700, "#0f131b")
    img = defocus(img, 30)
    bokeh(img, rng, 20, 25, 60, ["#ffd9a0", "#f2c48a"], alpha=(0.25, 0.5), region=(1500, 250, 2400, 1700))
    return finish(img, rng, vignette=0.3)


# ---------------------------------------------------------------- career photoshoot backdrops
def mottled(rng, base, light, dark, spot=0.22, mottle=0.09, vignette=0.28, cy=0.42):
    """Hand-painted studio backdrop: multi-scale mottling + a soft light spot behind the subject."""
    h = w = SIZE
    noise = np.zeros((h, w), np.float32)
    for sigma, amp in ((260, 1.0), (110, 0.55), (45, 0.25)):
        n = rng.normal(0, 1, (h // 8, w // 8)).astype(np.float32)
        n = cv2.resize(n, (w, h), interpolation=cv2.INTER_CUBIC)
        n = cv2.GaussianBlur(n, (0, 0), sigmaX=sigma / 2)
        n /= (np.abs(n).max() + 1e-6)
        noise += n * amp
    noise /= np.abs(noise).max() + 1e-6
    yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)
    d = np.sqrt(((xx - w / 2) / (w * 0.55)) ** 2 + ((yy - h * cy) / (h * 0.6)) ** 2)
    glow = np.clip(1 - d, 0, 1) ** 1.6
    t = np.clip(0.5 + noise * mottle * 4, 0, 1)[..., None]
    col = hex_rgb(dark) * (1 - t) + hex_rgb(light) * t
    col = col * 0.55 + hex_rgb(base) * 0.45
    col = col * (1 + spot * glow[..., None])
    img = col.astype(np.float32)
    return finish(img, rng, vignette=vignette, grain=1.8)


def seamless(rng, top, bottom, spot=0.08):
    img = vgrad(top, bottom)
    yy, xx = np.mgrid[0:SIZE, 0:SIZE].astype(np.float32)
    d = np.sqrt(((xx - SIZE / 2) / (SIZE * 0.6)) ** 2 + ((yy - SIZE * 0.4) / (SIZE * 0.6)) ** 2)
    img *= (1 + spot * np.clip(1 - d, 0, 1) ** 2)[..., None]
    return finish(img, rng, vignette=0.1, grain=1.4)


STUDIO = [
    ("studio-classic-grey", "Classic grey", lambda r: mottled(r, "#7f8387", "#b4b8bc", "#50545a")),
    ("studio-warm-canvas", "Warm canvas", lambda r: mottled(r, "#8a7563", "#c2ad97", "#5a4636")),
    ("studio-navy", "Navy studio", lambda r: mottled(r, "#2c3c58", "#5b7193", "#18233a", spot=0.3)),
    ("studio-charcoal", "Charcoal low-key", lambda r: mottled(r, "#333436", "#5d5f63", "#1c1d1f", spot=0.35, vignette=0.4)),
    ("studio-soft-blue", "Soft blue", lambda r: mottled(r, "#93a8bd", "#c9d6e3", "#6f8399", spot=0.18)),
    ("studio-olive", "Olive painted", lambda r: mottled(r, "#6f7260", "#a1a38c", "#45483a")),
    ("studio-cream-seamless", "Cream seamless", lambda r: seamless(r, "#f4ece2", "#e2d4c3")),
    ("studio-white", "White high-key", lambda r: seamless(r, "#fbfbfa", "#ececea", spot=0.03)),
]

SCENES = [
    ("glass-office", "Glass office", glass_office, "office"),
    ("open-plan", "Open-plan daylight", open_plan, "office"),
    ("plants-light", "Plants & window light", plants_light, "office"),
    ("warm-library", "Warm library", warm_library, "office"),
    ("boardroom-grey", "Boardroom grey", boardroom_grey, "office"),
    ("executive-navy", "Executive navy", executive_navy, "office"),
    ("city-dusk", "City window at dusk", city_dusk, "office"),
    ("studio-cream", "Cream studio", studio_cream, "studio"),
] + [(slug, label, fn, "studio") for slug, label, fn in STUDIO]


def main():
    os.makedirs(THUMBS, exist_ok=True)
    manifest = []
    for i, (slug, label, fn, group) in enumerate(SCENES):
        rng = np.random.default_rng(1000 + i)
        img = fn(rng)
        Image.fromarray(img).save(os.path.join(OUT, f"{slug}.jpg"), quality=86, optimize=True, progressive=True)
        Image.fromarray(img).resize((320, 320), Image.LANCZOS).save(
            os.path.join(THUMBS, f"{slug}.jpg"), quality=82, optimize=True)
        manifest.append({"id": slug, "label": label, "group": group, "src": f"/backgrounds/{slug}.jpg",
                         "thumb": f"/backgrounds/thumbs/{slug}.jpg", "credit": "Original artwork, CAREer Studio"})
        print("wrote", slug)
    with open(os.path.join(OUT, "manifest.json"), "w") as f:
        json.dump(manifest, f, indent=2)


if __name__ == "__main__":
    main()
