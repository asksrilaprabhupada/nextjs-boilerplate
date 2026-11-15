"""
build-redesign-assets.py — Makes the cinematic redesign's raster assets, once.

The approved designs (docs/redesign/designs/*.dc.html) draw film grain with a
live SVG feTurbulence filter and show the app icon as the gold face medallion on
a dark rounded square. A live turbulence filter is far too heavy for the
iPhone 6s the site is tested on, so the grain is baked here into one small
tileable PNG; the app icons are composed here from the supplied logo crop.

Run from the repository root:  python scripts/build-redesign-assets.py
Outputs (committed, so the build never runs this):
  public/images/redesign/grain.png      128×128 tile, used at low opacity
  app/apple-icon.png                    180×180 (iOS home screen)
  public/icons/icon-192.png, -512.png   PWA icons (app/manifest.ts)
Requires Pillow. Deterministic: the noise uses a fixed seed.
"""
import math
import os
import random

from PIL import Image, ImageChops, ImageDraw, ImageFilter

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FACE = os.path.join(ROOT, "public", "images", "redesign", "logo", "face-gold.webp")


def grain(path: str, size: int = 128) -> None:
    """Two octaves of grey noise centred on mid-grey (neutral under overlay)."""
    rnd = random.Random(1965)
    fine = Image.new("L", (size, size))
    fine.putdata([max(0, min(255, int(rnd.gauss(128, 46)))) for _ in range(size * size)])
    coarse_small = Image.new("L", (size // 2, size // 2))
    coarse_small.putdata([max(0, min(255, int(rnd.gauss(128, 40)))) for _ in range((size // 2) ** 2)])
    coarse = coarse_small.resize((size, size), Image.NEAREST)
    Image.blend(fine, coarse, 0.35).save(path, optimize=True)


def linear_gradient(size: int, angle_deg: float, stops):
    """CSS-style linear-gradient(angle, stops) rendered into an RGB image."""
    a = math.radians(angle_deg)
    dx, dy = math.sin(a), -math.cos(a)
    half = (abs(size * dx) + abs(size * dy)) / 2
    img = Image.new("RGB", (size, size))
    px = img.load()
    c = (size - 1) / 2
    for y in range(size):
        for x in range(size):
            t = ((x - c) * dx + (y - c) * dy) / (2 * half) + 0.5
            t = max(0.0, min(1.0, t))
            for i in range(len(stops) - 1):
                p0, c0 = stops[i]
                p1, c1 = stops[i + 1]
                if t <= p1 or i == len(stops) - 2:
                    f = 0 if p1 == p0 else max(0.0, min(1.0, (t - p0) / (p1 - p0)))
                    px[x, y] = tuple(int(c0[k] + (c1[k] - c0[k]) * f) for k in range(3))
                    break
    return img


def radial_background(size: int):
    """radial-gradient(circle at 50% 35%, #3a2d1b, #120e09 75%)."""
    img = Image.new("RGB", (size, size))
    px = img.load()
    cx, cy = size * 0.5, size * 0.35
    # "circle" farthest-corner radius from (50%, 35%).
    r_end = math.hypot(size * 0.5, size * 0.65) * 0.75
    a, b = (0x3A, 0x2D, 0x1B), (0x12, 0x0E, 0x09)
    for y in range(size):
        for x in range(size):
            t = min(1.0, math.hypot(x - cx, y - cy) / r_end)
            px[x, y] = tuple(int(a[k] + (b[k] - a[k]) * t) for k in range(3))
    return img


def circle_mask(size: int, scale: int = 4) -> Image.Image:
    big = Image.new("L", (size * scale, size * scale), 0)
    ImageDraw.Draw(big).ellipse((0, 0, size * scale - 1, size * scale - 1), fill=255)
    return big.resize((size, size), Image.LANCZOS)


def rounded_mask(size: int, radius: int, scale: int = 4) -> Image.Image:
    big = Image.new("L", (size * scale, size * scale), 0)
    ImageDraw.Draw(big).rounded_rectangle(
        (0, 0, size * scale - 1, size * scale - 1), radius=radius * scale, fill=255
    )
    return big.resize((size, size), Image.LANCZOS)


def medallion(diameter: int, ring: float) -> Image.Image:
    """The header medallion: gold ring, 1px-equivalent dark gap, gold face."""
    ring_img = linear_gradient(
        diameter,
        140,
        [(0.0, (0xFB, 0xEE, 0xC6)), (0.38, (0xD9, 0xB7, 0x6A)), (0.68, (0x8A, 0x6A, 0x2A)), (1.0, (0xE8, 0xCF, 0x8F))],
    ).convert("RGBA")
    out = Image.new("RGBA", (diameter, diameter), (0, 0, 0, 0))
    out.paste(ring_img, (0, 0), circle_mask(diameter))
    gap = max(1, round(diameter / 108))
    inner = diameter - 2 * round(ring)
    dark = Image.new("RGBA", (inner, inner), (0x12, 0x0E, 0x09, 255))
    out.paste(dark, (round(ring), round(ring)), circle_mask(inner))
    face_d = inner - 2 * gap
    face = Image.open(FACE).convert("RGBA").resize((face_d, face_d), Image.LANCZOS)
    out.paste(face, (round(ring) + gap, round(ring) + gap), circle_mask(face_d))
    return out


def app_icon(size: int, rounded: bool) -> Image.Image:
    """Logo sheet app icon: 108/132 medallion on a dark square, gold hairline."""
    bg = radial_background(size).convert("RGBA")
    diameter = round(size * 108 / 132)
    ring = size * 4 / 132
    med = medallion(diameter, ring)
    # 0 5px 19px rgba(0,0,0,.42) — a soft drop shadow under the medallion.
    shadow = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    off = (size - diameter) // 2
    sh = Image.new("L", (size, size), 0)
    ImageDraw.Draw(sh).ellipse(
        (off, off + size * 5 / 132, off + diameter, off + diameter + size * 5 / 132), fill=int(255 * 0.42)
    )
    sh = sh.filter(ImageFilter.GaussianBlur(size * 19 / 132 / 2))
    shadow.putalpha(sh)
    bg = Image.alpha_composite(bg, shadow)
    bg.alpha_composite(med, (off, off))
    radius = round(size * 30 / 132)
    # inset 0 0 0 1px rgba(217,183,106,.25): a faint gold hairline at the edge.
    line = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    lw = max(1, round(size / 132))
    ImageDraw.Draw(line).rounded_rectangle(
        (0, 0, size - 1, size - 1), radius=radius if rounded else 0,
        outline=(217, 183, 106, 64), width=lw,
    )
    bg = Image.alpha_composite(bg, line)
    if rounded:
        bg.putalpha(ImageChops.multiply(bg.getchannel("A"), rounded_mask(size, radius)))
    return bg


def main() -> None:
    grain(os.path.join(ROOT, "public", "images", "redesign", "grain.png"))
    # iOS rounds the home-screen icon itself, so the touch icon is full-bleed.
    app_icon(180, rounded=False).convert("RGB").save(os.path.join(ROOT, "app", "apple-icon.png"), optimize=True)
    os.makedirs(os.path.join(ROOT, "public", "icons"), exist_ok=True)
    for s in (192, 512):
        app_icon(s, rounded=True).save(os.path.join(ROOT, "public", "icons", f"icon-{s}.png"), optimize=True)


if __name__ == "__main__":
    main()
