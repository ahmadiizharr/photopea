"""Sample photos for the landing page's layout previews (run with the backend venv: needs Pillow).

    ../backend/.venv/bin/python scripts/make_demo_photos.py

Photos come from Unsplash (Unsplash License: free to use, no attribution required — we credit anyway).
Each one is cropped to its slot's aspect around a hand-picked focal point and written to
public/demo/<layout>-<n>.webp, sized for the 340 px tall preview at 3x.
"""

import io
import json
import urllib.request
from pathlib import Path

from PIL import Image, ImageOps

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "public" / "demo"
LAYOUTS = {l["id"]: l for l in json.loads((ROOT.parent / "shared" / "layouts.json").read_text())["layouts"]}
DISPLAY_H, DPR = 340, 3

# Unsplash photo id, focal x, focal y (fractions of the image), zoom (1 = largest crop that fits)
PLAN = {
    "strip4": [
        ("1494790108377-be9c29b29330", 0.50, 0.31, 1.15),
        ("1507003211169-0a1dd7228f2d", 0.50, 0.30, 1.00),
        ("1517365830460-955ce3ccd263", 0.50, 0.33, 1.30),
        ("1539571696357-5a69c17a67c6", 0.50, 0.38, 1.05),
    ],
    "strip3": [
        ("1517841905240-472988babdf9", 0.47, 0.38, 1.70),
        ("1500648767791-00dcc994a43e", 0.50, 0.33, 1.10),
        ("1544005313-94ddf0286df2", 0.50, 0.45, 1.20),
    ],
    "grid4": [
        ("1529626455594-4ff0802cfb7e", 0.55, 0.52, 1.10),
        ("1488426862026-3ee34a7d66df", 0.50, 0.38, 1.10),
        ("1534528741775-53994a69daeb", 0.50, 0.48, 1.10),
        ("1531746020798-e6953c6e8e04", 0.50, 0.45, 1.10),
    ],
    "polaroid": [
        ("1543807535-eceef0bc6599", 0.45, 0.42, 1.15),
    ],
}


def fetch(photo_id: str) -> Image.Image:
    url = f"https://images.unsplash.com/photo-{photo_id}?w=1400&q=85&fm=jpg"
    with urllib.request.urlopen(url, timeout=30) as r:
        return ImageOps.exif_transpose(Image.open(io.BytesIO(r.read()))).convert("RGB")


def crop(im: Image.Image, aspect: float, fx: float, fy: float, zoom: float) -> Image.Image:
    W, H = im.size
    cw = min(W, H * aspect) / zoom
    ch = cw / aspect
    x0 = min(max(fx * W - cw / 2, 0), W - cw)
    y0 = min(max(fy * H - ch / 2, 0), H - ch)
    return im.crop((round(x0), round(y0), round(x0 + cw), round(y0 + ch)))


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    for lid, shots in PLAN.items():
        layout = LAYOUTS[lid]
        assert len(shots) == layout["shots"], lid
        for n, ((photo_id, fx, fy, zoom), slot) in enumerate(zip(shots, layout["slots"]), 1):
            aspect = slot["w"] / slot["h"]
            width = min(slot["w"], round(slot["w"] * DISPLAY_H / layout["h"] * DPR))
            img = crop(fetch(photo_id), aspect, fx, fy, zoom).resize((width, round(width / aspect)), Image.Resampling.LANCZOS)
            path = OUT / f"{lid}-{n}.webp"
            img.save(path, "WEBP", quality=72, method=6)
            print(f"{path.relative_to(ROOT)}  {img.width}x{img.height}  {path.stat().st_size // 1024} KB")


if __name__ == "__main__":
    main()
