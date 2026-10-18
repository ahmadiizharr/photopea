"""Frame PNGs uploaded from the dashboard.

A frame is the artwork printed on top of the photos: a PNG at the exact print size whose photo
holes are transparent. On upload we normalise it to the format's pixel size, find the holes
(connected transparent regions), number them, and list anything that will print badly so the
superadmin can fix the file before guests see it.
"""

import io
from dataclasses import dataclass, field

from PIL import Image, ImageDraw, ImageFont, UnidentifiedImageError

Image.MAX_IMAGE_PIXELS = 30_000_000

HOLE_ALPHA = 128  # alpha below this counts as "photo shows through"
SAFE_PX = 36  # 3 mm at 300 dpi: what most photo printers trim or shift
MIN_HOLE_SIDE = 300
MAX_HOLES = 12
MAX_PHOTOS = 8
# Placeholder colours for "Foto N" in previews and guides.
PHOTO_COLORS = ["#ff7eb3", "#3aa0ff", "#22c07a", "#8a5cff", "#ffb020", "#ff6a3d", "#14b8c4", "#c45cff"]


class BadFrame(ValueError):
    pass


@dataclass
class Analysis:
    image: Image.Image  # RGBA at the format's exact size
    slots: list[dict]  # {x, y, w, h, photo}, in photo-number order
    issues: list[dict] = field(default_factory=list)  # {level: error|warn|info, text}

    @property
    def ok(self) -> bool:
        return not any(i["level"] == "error" for i in self.issues)


def _issue(issues: list, level: str, text: str) -> None:
    issues.append({"level": level, "text": text})


def load(data: bytes, fmt: dict) -> tuple[Image.Image, list[dict]]:
    """Decode an uploaded PNG and bring it to the format's pixel size."""
    issues: list[dict] = []
    try:
        with Image.open(io.BytesIO(data)) as probe:
            if probe.format != "PNG":
                raise BadFrame("File harus PNG (dengan latar transparan).")
            w, h = probe.size
            if w * h > Image.MAX_IMAGE_PIXELS:
                raise BadFrame(f"Gambar terlalu besar ({w}×{h}).")
            probe.load()
            has_alpha = "A" in probe.getbands() or "transparency" in probe.info
            im = probe.convert("RGBA")
    except (UnidentifiedImageError, OSError, Image.DecompressionBombError) as e:
        raise BadFrame("Bukan file PNG yang valid.") from e
    if not has_alpha:
        raise BadFrame("PNG ini tidak punya transparansi. Lubang foto harus transparan (simpan sebagai PNG-24/PNG dengan alpha).")

    W, H = fmt["w"], fmt["h"]
    if abs((w / h) - (W / H)) / (W / H) > 0.02:
        orient = " Sepertinya gambarnya terputar (landscape/portrait tertukar)." if abs((h / w) - (W / H)) / (W / H) <= 0.02 else ""
        raise BadFrame(f"Rasio {w}×{h} tidak cocok untuk {fmt['name']}. Buat ulang di {W}×{H} px (300 dpi).{orient}")
    if (w, h) != (W, H):
        if w < W:
            _issue(issues, "warn", f"Ukuran {w}×{h} lebih kecil dari {W}×{H}; frame diperbesar dan bisa terlihat pecah saat dicetak.")
        else:
            _issue(issues, "info", f"Ukuran {w}×{h} diperkecil ke {W}×{H} px.")
        im = im.resize((W, H), Image.Resampling.LANCZOS)
    return im, issues


def _components(mask: bytes, w: int, h: int) -> list[tuple[int, int, int, int, int]]:
    """4-connected regions of 1s in a w×h byte mask → (minx, miny, maxx, maxy, count)."""
    seen = bytearray(w * h)
    out = []
    for start in range(w * h):
        if not mask[start] or seen[start]:
            continue
        seen[start] = 1
        stack = [start]
        minx = miny = 1 << 30
        maxx = maxy = count = 0
        while stack:
            i = stack.pop()
            y, x = divmod(i, w)
            count += 1
            minx, maxx = min(minx, x), max(maxx, x)
            miny, maxy = min(miny, y), max(maxy, y)
            for j, inside in ((i - 1, x > 0), (i + 1, x < w - 1), (i - w, y > 0), (i + w, y < h - 1)):
                if inside and mask[j] and not seen[j]:
                    seen[j] = 1
                    stack.append(j)
        out.append((minx, miny, maxx, maxy, count))
    return out


def _reading_order(boxes: list[dict]) -> list[dict]:
    """Top-to-bottom rows, left-to-right inside a row."""
    rows: list[list[dict]] = []
    for b in sorted(boxes, key=lambda b: b["y"] + b["h"] / 2):
        cy = b["y"] + b["h"] / 2
        if rows:
            r = rows[-1]
            rcy = sum(x["y"] + x["h"] / 2 for x in r) / len(r)
            if abs(cy - rcy) < min(min(x["h"] for x in r), b["h"]) * 0.4:
                r.append(b)
                continue
        rows.append([b])
    return [b for r in rows for b in sorted(r, key=lambda b: b["x"])]


def detect(im: Image.Image, fmt: dict, issues: list[dict]) -> list[dict]:
    W, H = im.size
    alpha = im.getchannel("A")
    f = max(1, round(max(W, H) / 500))  # label on a ~500 px grid, then refine at full size
    sw, sh = -(-W // f), -(-H // f)
    small = alpha.resize((sw, sh), Image.Resampling.BOX)
    mask = small.point(lambda a: 1 if a < HOLE_ALPHA else 0).tobytes()

    hole_mask = alpha.point(lambda a: 255 if a < HOLE_ALPHA else 0)
    boxes, specks = [], 0
    for minx, miny, maxx, maxy, count in _components(mask, sw, sh):
        frac = count / (sw * sh)
        if frac < 0.004:
            specks += 1
            continue
        edges = (minx == 0) + (miny == 0) + (maxx == sw - 1) + (maxy == sh - 1)
        if frac > 0.9 or (frac > 0.5 and edges >= 3):
            raise BadFrame("Area transparan menutupi hampir seluruh gambar. Latar frame ikut transparan? Hanya lubang foto yang boleh transparan.")
        x0, y0 = max(0, (minx - 1) * f), max(0, (miny - 1) * f)
        x1, y1 = min(W, (maxx + 2) * f), min(H, (maxy + 2) * f)
        bb = hole_mask.crop((x0, y0, x1, y1)).getbbox()
        if bb is None:
            continue
        bx0, by0, bx1, by1 = x0 + bb[0], y0 + bb[1], x0 + bb[2], y0 + bb[3]
        fill = count * f * f / max(1, (bx1 - bx0) * (by1 - by0))
        boxes.append({"x": bx0, "y": by0, "w": bx1 - bx0, "h": by1 - by0, "fill": min(1.0, fill)})

    if not boxes:
        raise BadFrame("Tidak ada lubang foto. Bagian tempat foto harus benar-benar transparan (alpha 0).")
    if len(boxes) > MAX_HOLES:
        raise BadFrame(f"Ada {len(boxes)} area transparan terpisah. Maksimal {MAX_HOLES}; pastikan hanya lubang foto yang transparan.")
    if specks:
        _issue(issues, "info", f"{specks} titik transparan kecil diabaikan (bukan lubang foto).")

    cut = fmt.get("cut_x")
    if cut:
        left = _reading_order([b for b in boxes if b["x"] + b["w"] / 2 < cut])
        right = _reading_order([b for b in boxes if b["x"] + b["w"] / 2 >= cut])
        ordered = left + right
        twins = len(left) == len(right) and all(
            abs(a["w"] - b["w"]) <= W * 0.02 and abs(a["h"] - b["h"]) <= H * 0.02 and abs(a["y"] - b["y"]) <= H * 0.02
            for a, b in zip(left, right)
        )
        if twins:
            photos = list(range(1, len(left) + 1)) * 2
            _issue(issues, "info", f"Strip kiri dan kanan kembar: {len(left)} foto, masing-masing dicetak dua kali.")
        else:
            photos = list(range(1, len(ordered) + 1))
            if left and right:
                _issue(issues, "info", f"Strip kiri ({len(left)} lubang) dan kanan ({len(right)} lubang) berbeda, jadi setiap lubang diisi foto berbeda.")
    else:
        ordered = _reading_order(boxes)
        photos = list(range(1, len(ordered) + 1))

    n_photos = max(photos)
    if n_photos > MAX_PHOTOS:
        _issue(issues, "error", f"Frame ini butuh {n_photos} foto berbeda; maksimal {MAX_PHOTOS} per sesi.")

    slots = []
    for k, (b, photo) in enumerate(zip(ordered, photos), 1):
        x0, y0, x1, y1 = b["x"], b["y"], b["x"] + b["w"], b["y"] + b["h"]
        name = f"Lubang {k}"
        if x0 <= 0 or y0 <= 0 or x1 >= W or y1 >= H:
            _issue(issues, "warn", f"{name} menyentuh tepi kertas. Printer biasanya memotong ±3 mm, jadi tepi foto bisa hilang.")
        elif min(x0, y0, W - x1, H - y1) < SAFE_PX:
            _issue(issues, "warn", f"{name} terlalu dekat tepi (kurang dari 3 mm / {SAFE_PX} px).")
        if cut and x0 < cut + 12 and x1 > cut - 12:
            _issue(issues, "error", f"{name} melewati garis potong tengah (x = {cut} px). Geser supaya strip bisa dipotong.")
        if min(b["w"], b["h"]) < MIN_HOLE_SIDE:
            _issue(issues, "warn", f"{name} kecil ({b['w']}×{b['h']} px); wajah jadi kecil. Usahakan sisi terpendek ≥ {MIN_HOLE_SIDE} px.")
        ar = b["w"] / b["h"]
        if ar > 2.2 or ar < 0.45:
            _issue(issues, "warn", f"{name} sangat lonjong ({b['w']}×{b['h']}); gambar kamera akan banyak terpotong.")
        if b["fill"] < 0.85:
            _issue(issues, "info", f"{name} berbentuk bebas; foto diisi ke kotak luarnya dan bagian di luar bentuk tertutup frame.")
        region = alpha.crop((x0, y0, x1, y1))
        hist = region.histogram()
        semi = sum(hist[12:HOLE_ALPHA])
        if semi > 0.04 * b["w"] * b["h"]:
            _issue(issues, "warn", f"{name} berisi piksel semi-transparan (teks, bayangan, atau efek) yang akan menempel di atas foto.")
        slots.append({"x": x0, "y": y0, "w": b["w"], "h": b["h"], "photo": photo})
    return slots


def analyze(data: bytes, fmt: dict) -> Analysis:
    im, issues = load(data, fmt)
    slots = detect(im, fmt, issues)
    n = max(s["photo"] for s in slots)
    issues.insert(0, {"level": "info", "text": f"Terdeteksi {len(slots)} lubang untuk {n} foto per sesi."})
    return Analysis(im, slots, issues)


def save_png(im: Image.Image) -> bytes:
    buf = io.BytesIO()
    im.save(buf, "PNG", optimize=True)
    return buf.getvalue()


def _font(size: int) -> ImageFont.FreeTypeFont:
    return ImageFont.load_default(size=size)


def _label(draw: ImageDraw.ImageDraw, s: dict, text: str, fill) -> None:
    """Centred text shrunk to stay well inside the slot (it must never bridge two holes)."""
    size = max(10, min(s["w"], s["h"]) // 6)
    font = _font(size)
    while size > 10 and draw.textlength(text, font=font) > s["w"] * 0.8:
        size -= 2
        font = _font(size)
    draw.text((s["x"] + s["w"] / 2, s["y"] + s["h"] / 2), text, fill=fill, font=font, anchor="mm")


def preview(frame: Image.Image, slots: list[dict], width: int = 480) -> bytes:
    """Coloured "FOTO n" blocks under the frame, like a contact sheet. WEBP."""
    base = Image.new("RGBA", frame.size, "#ffffff")
    d = ImageDraw.Draw(base)
    for s in slots:
        d.rectangle((s["x"], s["y"], s["x"] + s["w"], s["y"] + s["h"]), fill=PHOTO_COLORS[(s["photo"] - 1) % len(PHOTO_COLORS)])
        _label(d, s, f"FOTO {s['photo']}", "#ffffff")
    base.alpha_composite(frame)
    base = base.convert("RGB")
    base.thumbnail((width, width * 3), Image.Resampling.LANCZOS)
    buf = io.BytesIO()
    base.save(buf, "WEBP", quality=80, method=5)
    return buf.getvalue()


def guide(fmt: dict, preset: dict) -> bytes:
    """Starter PNG for designers: paper with transparent holes, safe area and cut line marked.

    Hole labels are drawn at low alpha so they stay inside the "transparent" threshold and the
    file still uploads cleanly; the dashed guides are meant to be painted over.
    """
    W, H = fmt["w"], fmt["h"]
    im = Image.new("RGBA", (W, H), (251, 247, 239, 255))
    d = ImageDraw.Draw(im)
    for s in preset["slots"]:
        d.rectangle((s["x"], s["y"], s["x"] + s["w"] - 1, s["y"] + s["h"] - 1), fill=(0, 0, 0, 0))
        _label(d, s, f"FOTO {s['photo']} · {s['w']}x{s['h']}", (22, 17, 14, 70))

    def dashed(x0, y0, x1, y1, color, dash=18, gap=12, width=3):
        length = max(abs(x1 - x0), abs(y1 - y0))
        pos = 0
        while pos < length:
            end = min(pos + dash, length)
            if x0 == x1:
                d.line((x0, y0 + pos, x1, y0 + end), fill=color, width=width)
            else:
                d.line((x0 + pos, y0, x0 + end, y1), fill=color, width=width)
            pos += dash + gap

    pink, blue, grey = (255, 61, 139, 255), (29, 79, 216, 255), (59, 51, 45, 255)
    m = SAFE_PX
    for seg in ((m, m, W - m, m), (m, H - m, W - m, H - m), (m, m, m, H - m), (W - m, m, W - m, H - m)):
        dashed(*seg, pink)
    if fmt.get("cut_x"):
        dashed(fmt["cut_x"], 0, fmt["cut_x"], H, blue, width=4)
    caption = f"{fmt['name']} · {W}x{H} px · 300 dpi · garis pink = batas aman 3 mm"
    if fmt.get("cut_x"):
        caption += " · garis biru = potong"
    d.text((m + 8, H - m - 10), caption, fill=grey, font=_font(max(14, W // 60)), anchor="ls")
    return save_png(im)
