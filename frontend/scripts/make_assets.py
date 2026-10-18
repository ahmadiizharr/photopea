"""Render the PNG icons and the OG card from code (run with the backend venv: needs Pillow).

    ../backend/.venv/bin/python scripts/make_assets.py
"""

import io
import urllib.request
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

PUBLIC = Path(__file__).resolve().parents[1] / "public"
PAPER, INK, PINK, YELLOW, BLUE = "#f4ecdd", "#16110e", "#ff3d8b", "#ffd23e", "#1d4fd8"
FONT_URL = "https://github.com/google/fonts/raw/main/ofl/bricolagegrotesque/BricolageGrotesque%5Bopsz,wdth,wght%5D.ttf"


def camera(size: int, pad: float) -> Image.Image:
    """The logo mark: yellow camera body, pink lens, ink outline and hard shadow."""
    s = size * 4  # supersample
    im = Image.new("RGBA", (s, s), PAPER)
    d = ImageDraw.Draw(im)
    u = s * (1 - 2 * pad) / 64
    o = s * pad
    P = lambda x, y: (o + x * u, o + y * u)  # noqa: E731
    w = 4.5 * u
    d.rounded_rectangle([*P(18, 10), *P(32, 20)], radius=2 * u, fill=PINK, outline=INK, width=round(4 * u))
    d.rounded_rectangle([*P(10, 21), *P(62, 58)], radius=9 * u, fill=INK)
    d.rounded_rectangle([*P(5, 16), *P(57, 53)], radius=9 * u, fill=YELLOW, outline=INK, width=round(w))
    d.ellipse([*P(20, 24.5), *P(40, 44.5)], fill=PINK, outline=INK, width=round(w))
    im = im.rotate(6, resample=Image.Resampling.BICUBIC, fillcolor=PAPER)
    return im.resize((size, size), Image.Resampling.LANCZOS).convert("RGB")


def font(px: int, wght: int = 800) -> ImageFont.FreeTypeFont:
    cache = PUBLIC.parent / "scripts" / ".bricolage.ttf"
    if not cache.exists():
        cache.write_bytes(urllib.request.urlopen(FONT_URL, timeout=30).read())
    f = ImageFont.truetype(str(cache), px)
    try:
        f.set_variation_by_axes([96, wght, 88])  # opsz, wght, wdth
    except Exception:
        pass
    return f


def og() -> Image.Image:
    W, H = 1200, 630
    im = Image.new("RGB", (W, H), PAPER)
    d = ImageDraw.Draw(im)
    # halftone corner
    for y in range(0, H, 14):
        for x in range(0, W, 14):
            t = 1 - ((W - x) ** 2 + (0 - y) ** 2) ** 0.5 / 620
            if t > 0:
                r = 5 * min(1, t * 1.2)
                d.ellipse([x - r, y - r, x + r, y + r], fill=PINK)
    big = font(150)
    d.text((70, 120), "Senyum.", font=big, fill=INK)
    # pink "Jepret." label
    bbox = d.textbbox((70, 270), "Jepret.", font=big)
    d.rounded_rectangle([bbox[0] + 8 - 14, bbox[1] - 10 + 8, bbox[2] + 8 + 10, bbox[3] + 14 + 8], radius=20, fill=INK)
    d.rounded_rectangle([bbox[0] - 14, bbox[1] - 10, bbox[2] + 10, bbox[3] + 14], radius=20, fill=PINK, outline=INK, width=5)
    d.text((70, 270), "Jepret.", font=big, fill="#ffffff")
    d.text((70, 430), "Bawa pulang.", font=big, fill=BLUE)
    # mini strip on the right
    sx, sy, sw = 930, 70, 190
    d.rectangle([sx + 12, sy + 12, sx + sw + 12, sy + 500 + 12], fill=INK)
    d.rectangle([sx, sy, sx + sw, sy + 500], fill=YELLOW, outline=INK, width=5)
    tints = ["#ffd5e6", "#dde6ff", "#fff1c2", "#ffd5e6"]
    for i in range(4):
        y0 = sy + 16 + i * 108
        d.rectangle([sx + 16, y0, sx + sw - 16, y0 + 96], fill=tints[i], outline=INK, width=4)
        cx, cy = sx + sw / 2, y0 + 50
        d.ellipse([cx - 30, cy - 30, cx + 30, cy + 30], fill=PAPER, outline=INK, width=4)
        d.ellipse([cx - 14, cy - 10, cx - 6, cy - 2], fill=INK)
        d.ellipse([cx + 6, cy - 10, cx + 14, cy - 2], fill=INK)
        d.arc([cx - 14, cy - 6, cx + 14, cy + 16], 20, 160, fill=INK, width=4)
    return im


if __name__ == "__main__":
    camera(192, 0.06).save(PUBLIC / "icon-192.png")
    camera(512, 0.06).save(PUBLIC / "icon-512.png")
    camera(512, 0.16).save(PUBLIC / "icon-maskable-512.png")
    og().save(PUBLIC / "og.png", optimize=True)
    print("ok")
