#!/usr/bin/env python3
"""Trucking OS Tracker launcher icons - re-runnable generator (owner order 2026-11-08).

Source art: icon-source/brand-art-512.png, a copy of the web app's public/icons/icon-512.png (the black-and-gold semi truck brand art).
Two composed masters (committed, so a re-run needs no font):
  master-fullbleed-1024.png  the art full bleed with a gold banner band across the bottom reading TRACKER   -> legacy icons
  master-nameplate-1024.png  the art with an INSET gold TRACKER nameplate (ends well inside the frame)      -> adaptive foregrounds, round icons
Banner gold is RGB(188, 150, 58); lettering is black, bold, letter-spaced. Adaptive background colour is #000000.

  python3 icon-source/generate.py            # re-render every res/mipmap-* PNG + values/ic_launcher_background.xml from the masters
  python3 icon-source/generate.py --compose  # first rebuild the masters from the art (needs a bold sans font; see FONTS)
Requires Pillow. Icon resources only: no code, no app name, no package change.
"""
from __future__ import annotations

import math
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

HERE = Path(__file__).resolve().parent
RES = HERE.parent / "android" / "app" / "src" / "main" / "res"
ART = HERE / "brand-art-512.png"
FULLBLEED = HERE / "master-fullbleed-1024.png"
NAMEPLATE = HERE / "master-nameplate-1024.png"

GOLD = (188, 150, 58)
BLACK = (0, 0, 0)
LABEL = "TRACKER"
M = 1024  # master size

FONTS = [
    "/usr/share/fonts/opentype/inter/Inter-ExtraBold.otf",
    "/usr/share/fonts/opentype/inter/Inter-Bold.otf",
    "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
]

# Legacy / round PNG sizes per density; adaptive foreground sizes (108dp canvas).
LEGACY = {"mdpi": 48, "hdpi": 72, "xhdpi": 96, "xxhdpi": 144, "xxxhdpi": 192}
FOREGROUND = {"mdpi": 108, "hdpi": 162, "xhdpi": 216, "xxhdpi": 324, "xxxhdpi": 432}

# Geometry as fractions of the master.
BAND_TOP = 0.79  # full-bleed band: from 79% down to the bottom edge
PLATE = (0.24, 0.655, 0.76, 0.785)  # inset nameplate box (x0, y0, x1, y1)
PLATE_RADIUS = 0.03
COMPOSITION_SCALE = 0.84  # the nameplate composition occupies 84% of the icon canvas
ADAPTIVE_VIEWPORT = 72 / 108  # the part of the 108dp adaptive canvas that every launcher mask keeps (a circle at worst)
TRACKING = 0.22  # letter spacing, in em


def font(size: int) -> ImageFont.FreeTypeFont:
    for path in FONTS:
        if Path(path).exists():
            return ImageFont.truetype(path, size)
    raise SystemExit("no bold font found; compose needs one of: " + ", ".join(FONTS))


def draw_label(draw: ImageDraw.ImageDraw, box: tuple[float, float, float, float], width_fraction: float) -> None:
    """Black, bold, letter-spaced TRACKER centred in `box`, spanning `width_fraction` of the box width."""
    x0, y0, x1, y1 = box
    target_w = (x1 - x0) * width_fraction
    size = int((y1 - y0) * 0.62)
    while size > 8:
        f = font(size)
        widths = [f.getlength(c) for c in LABEL]
        total = sum(widths) + TRACKING * size * (len(LABEL) - 1)
        if total <= target_w:
            break
        size -= 2
    f = font(size)
    widths = [f.getlength(c) for c in LABEL]
    total = sum(widths) + TRACKING * size * (len(LABEL) - 1)
    x = x0 + ((x1 - x0) - total) / 2
    bbox = f.getbbox("H")
    cy = (y0 + y1) / 2 - (bbox[1] + bbox[3]) / 2
    for c, w in zip(LABEL, widths):
        draw.text((x, cy), c, font=f, fill=BLACK)
        x += w + TRACKING * size


def compose() -> None:
    art = Image.open(ART).convert("RGB").resize((M, M), Image.LANCZOS)

    full = art.copy()
    d = ImageDraw.Draw(full)
    top = round(BAND_TOP * M)
    d.rectangle((0, top, M, M), fill=GOLD)
    d.line((0, top, M, top), fill=BLACK, width=max(2, M // 256))
    draw_label(d, (0, top, M, M), 0.74)
    full.save(FULLBLEED, optimize=True)

    plate = art.copy()
    d = ImageDraw.Draw(plate)
    box = tuple(round(v * M) for v in PLATE)
    d.rounded_rectangle(box, radius=round(PLATE_RADIUS * M), fill=GOLD, outline=BLACK, width=max(3, M // 170))
    draw_label(d, tuple(float(v) for v in box), 0.80)
    plate.save(NAMEPLATE, optimize=True)


def check_geometry() -> None:
    """Every nameplate corner must sit inside the circle that the strictest launcher mask keeps (and inside the round icon's circle)."""
    cx = cy = 0.5
    x0, y0, x1, y1 = PLATE
    worst = max(math.hypot(x - cx, y - cy) for x in (x0, x1) for y in (y0, y1))
    adaptive_keep = (ADAPTIVE_VIEWPORT / 2) / COMPOSITION_SCALE  # radius of the kept circle, in composition units
    round_keep = 0.5 / COMPOSITION_SCALE
    assert worst <= adaptive_keep - 0.005, f"nameplate corner at {worst:.3f} is outside the adaptive mask-safe circle {adaptive_keep:.3f}"
    assert worst <= round_keep, f"nameplate corner at {worst:.3f} clips in the round icon"
    print(f"nameplate corner radius {worst:.3f} <= adaptive safe {adaptive_keep:.3f} and round {round_keep:.3f}  OK")


def fit(master: Image.Image, size: int) -> Image.Image:
    return master.resize((size, size), Image.LANCZOS)


def render() -> None:
    full = Image.open(FULLBLEED).convert("RGB")
    plate = Image.open(NAMEPLATE).convert("RGB")
    for density, size in LEGACY.items():
        out = RES / f"mipmap-{density}"
        out.mkdir(parents=True, exist_ok=True)
        # Legacy square icon: the full-bleed art with the gold band.
        fit(full, size).save(out / "ic_launcher.png", optimize=True)
        # Round icon: the INSET nameplate composition at 84% on black, in a black disc (the band's ends would clip if the full-bleed art were cropped).
        s4 = size * 4
        canvas = Image.new("RGBA", (s4, s4), (0, 0, 0, 0))
        disc = Image.new("L", (s4, s4), 0)
        ImageDraw.Draw(disc).ellipse((0, 0, s4 - 1, s4 - 1), fill=255)
        black = Image.new("RGBA", (s4, s4), (0, 0, 0, 255))
        canvas.paste(black, (0, 0), disc)
        inner = round(s4 * COMPOSITION_SCALE)
        canvas.paste(fit(plate, inner).convert("RGBA"), ((s4 - inner) // 2, (s4 - inner) // 2))
        canvas.putalpha(Image.composite(canvas.getchannel("A"), Image.new("L", (s4, s4), 0), disc))
        canvas.resize((size, size), Image.LANCZOS).save(out / "ic_launcher_round.png", optimize=True)
    for density, size in FOREGROUND.items():
        out = RES / f"mipmap-{density}"
        # Adaptive foreground: the nameplate composition at 84% of the canvas, on transparency.
        canvas = Image.new("RGBA", (size, size), (0, 0, 0, 0))
        inner = round(size * COMPOSITION_SCALE)
        canvas.paste(fit(plate, inner).convert("RGBA"), ((size - inner) // 2, (size - inner) // 2))
        canvas.save(out / "ic_launcher_foreground.png", optimize=True)
    (RES / "values" / "ic_launcher_background.xml").write_text(
        '<?xml version="1.0" encoding="utf-8"?>\n<resources>\n    <color name="ic_launcher_background">#000000</color>\n</resources>\n'
    )
    print("rendered", len(LEGACY) * 2 + len(FOREGROUND), "PNGs and the #000000 adaptive background")


if __name__ == "__main__":
    if "--compose" in sys.argv:
        compose()
    check_geometry()
    render()
