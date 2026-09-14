#!/usr/bin/env python3
"""
Draws the launcher icons.

The app ships no art assets — the board, the pieces and the icon are all code — so the icon is drawn
here rather than exported from a design tool. One `draw_bead()` primitive produces three variants:

  * `legacy-<density>.png`     the composed icon (rounded sandalwood tile + bead), for Android < 8;
  * `foreground-<density>.png` the bead alone on transparency, for the adaptive icon;
  * `background-<density>.png` the bare gradient, which Android masks into whatever shape the
                               launcher wants (circle, squircle, teardrop…).

Everything is drawn at 4× and downsampled, because Pillow's ellipse and text rasterisers are not
antialiased and a 48 px launcher icon is exactly where that shows.

Usage:  python3 scripts/build-icons.py
"""

from __future__ import annotations

import os
from PIL import Image, ImageDraw, ImageFont

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "cordova", "res", "icon", "android")

# Launcher icon sizes per density (the legacy, pre-adaptive size).
LEGACY = {
    "ldpi": 36,
    "mdpi": 48,
    "hdpi": 72,
    "xhdpi": 96,
    "xxhdpi": 144,
    "xxxhdpi": 192,
}

# Adaptive icons are authored on a 108dp canvas; Android only guarantees the inner 72dp (66.7%) is
# visible, so the bead is kept well inside that.
ADAPTIVE = {
    "mdpi": 108,
    "hdpi": 162,
    "xhdpi": 216,
    "xxhdpi": 324,
    "xxxhdpi": 432,
}

# The palette, matching src/ui/palette.ts.
WOOD_CENTRE = (94, 60, 36)
WOOD_EDGE = (33, 20, 13)
CINNABAR = (176, 48, 31)
CINNABAR_DEEP = (126, 30, 18)
IVORY = (240, 226, 196)
IVORY_SHADE = (214, 193, 158)

SUPERSAMPLE = 4

FONT_CANDIDATES = [
    "/System/Library/Fonts/Supplemental/Songti.ttc",
    "/System/Library/Fonts/Songti.ttc",
    "/System/Library/Fonts/Supplemental/STHeiti Medium.ttc",
    "/System/Library/Fonts/STHeiti Medium.ttc",
    "/System/Library/Fonts/Supplemental/Kaiti.ttc",
]


def load_font(size: int) -> ImageFont.FreeTypeFont:
    for path in FONT_CANDIDATES:
        if os.path.exists(path):
            try:
                return ImageFont.truetype(path, size)
            except OSError:
                continue
    raise SystemExit("no CJK font found — the icon needs one for 棋")


def radial_background(size: int) -> Image.Image:
    """A soft radial gradient, drawn as concentric circles because Pillow has no gradient primitive."""
    layer = Image.new("RGB", (size, size), WOOD_EDGE)
    draw = ImageDraw.Draw(layer)
    centre = size / 2
    steps = max(48, size // 2)
    for i in range(steps, 0, -1):
        t = i / steps
        colour = tuple(
            round(WOOD_CENTRE[c] + (WOOD_EDGE[c] - WOOD_CENTRE[c]) * (t**1.4)) for c in range(3)
        )
        radius = centre * 1.42 * t
        draw.ellipse((centre - radius, centre - radius, centre + radius, centre + radius), fill=colour)
    return layer


def draw_bead(img: Image.Image, size: int, ratio: float, shadow: tuple | None) -> None:
    """Draws the chess piece: a rimmed ivory disc with 棋 carved into it.

    `shadow` is an **opaque** colour or `None`. It cannot be a translucent black: `ImageDraw` does not
    alpha-composite a 4-tuple fill, it *overwrites* the pixel with it — so a `(0,0,0,64)` ring punched
    a hole in the tile and showed up as a pale halo instead of a shadow. The caller darkens the local
    background colour instead.
    """
    draw = ImageDraw.Draw(img)
    centre = size / 2
    radius = size * ratio / 2

    def circle(r: float, fill=None, outline=None, width: int = 0) -> None:
        box = (centre - r, centre - r, centre + r, centre + r)
        if fill is not None:
            draw.ellipse(box, fill=fill)
        if outline is not None:
            draw.ellipse(box, outline=outline, width=width)

    # A tight drop shadow, so the bead reads as sitting on the tile rather than printed on it.
    if shadow is not None:
        circle(radius * 1.05, fill=shadow)
    # The rim is a two-step bevel: a deep 朱砂 edge with a brighter band inside it. An intermediate
    # shade of ivory was tried here first and read as a grey ring — the bevel has to come from the rim.
    circle(radius, fill=CINNABAR_DEEP)
    circle(radius * 0.94, fill=CINNABAR)
    circle(radius * 0.885, fill=IVORY)

    ring = max(2, round(radius * 0.045))
    circle(radius * 0.735, outline=CINNABAR, width=ring)

    # The character sits inside the ring with a little air, which is what keeps 棋 legible at 48 px —
    # 棋 is twelve strokes and crowds the ring at any size if it is allowed to fill the face.
    font = load_font(round(radius * 0.88))
    glyph = "棋"
    box = draw.textbbox((0, 0), glyph, font=font)
    draw.text(
        (centre - (box[0] + box[2]) / 2, centre - (box[1] + box[3]) / 2 - radius * 0.015),
        glyph,
        font=font,
        fill=CINNABAR,
    )


def rounded_mask(size: int, radius_ratio: float) -> Image.Image:
    mask = Image.new("L", (size, size), 0)
    ImageDraw.Draw(mask).rounded_rectangle(
        (0, 0, size - 1, size - 1), radius=size * radius_ratio, fill=255
    )
    return mask


def render(size: int, kind: str, ratio: float, corner: float | None) -> Image.Image:
    """kind: 'legacy' | 'foreground' | 'background'."""
    big = size * SUPERSAMPLE
    if kind == "foreground":
        # Fully transparent: Android supplies the shape, the launcher supplies the background. No drop
        # shadow here — it would have to carry alpha, and the rim already separates the bead.
        canvas = Image.new("RGBA", (big, big), (0, 0, 0, 0))
        draw_bead(canvas, big, ratio, None)
    else:
        canvas = radial_background(big).convert("RGBA")
        if corner is not None:
            canvas.putalpha(rounded_mask(big, corner))
        if kind == "background":
            return canvas.resize((size, size), Image.LANCZOS)
        # Darken the tile's own colour where the shadow falls, so it blends into the gradient rather
        # than sitting on top of it as a flat ring.
        probe = canvas.getpixel((round(big / 2 + big * ratio * 0.52), big // 2))[:3]
        shadow = tuple(round(channel * 0.42) for channel in probe)
        draw_bead(canvas, big, ratio, shadow)

    return canvas.resize((size, size), Image.LANCZOS)


def main() -> None:
    os.makedirs(OUT, exist_ok=True)
    written = 0

    for density, size in LEGACY.items():
        # 90% of the tile: big enough to read at 48 px, small enough to survive the round mask some
        # launchers apply even to legacy icons.
        render(size, "legacy", 0.90, 0.20).save(os.path.join(OUT, f"legacy-{density}.png"))
        written += 1

    for density, size in ADAPTIVE.items():
        # 55% of the 108dp canvas. Android shows the inner 72dp (66.7%) under a circular mask, so this
        # leaves the bead at ~83% of what is visible — big enough to fill the icon, with a margin that
        # survives every mask shape instead of having its rim shaved off by the circle.
        render(size, "foreground", 0.55, None).save(os.path.join(OUT, f"foreground-{density}.png"))
        render(size, "background", 1.0, None).save(os.path.join(OUT, f"background-{density}.png"))
        written += 2

    print(f"wrote {written} icons to {os.path.relpath(OUT, ROOT)}")
    for density, size in LEGACY.items():
        adaptive = ADAPTIVE.get(density)
        extra = f"  + adaptive foreground/background {adaptive}x{adaptive}" if adaptive else ""
        print(f"  legacy-{density:<8} {size:>3}x{size:<3}{extra}")


if __name__ == "__main__":
    main()
