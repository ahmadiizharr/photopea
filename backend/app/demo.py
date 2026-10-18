"""Dummy packs, frames and price packages so the booth can be tried end to end.

    .venv/bin/python -m app.cli seed-demo             # isi data contoh (tanya password superadmin)
    .venv/bin/python -m app.cli seed-demo --remove    # hapus lagi

Everything goes through the admin API, like the dashboard, so the files end up owned by the
service user and every frame passes the same hole detector. Demo items are recognised by name
("Demo · …" packs, "Demo …" packages) and replaced on every run; nothing else is touched.
"""

import http.cookiejar
import io
import json
import secrets
import urllib.error
import urllib.request

from PIL import Image, ImageDraw, ImageFont

PACK_PREFIX = "Demo · "
PACKAGE_PREFIX = "Demo "

CREAM = {"bg": (251, 247, 239), "dot": (240, 228, 206), "ink": (22, 17, 14), "accent": (255, 61, 139)}
PINK = {"bg": (255, 214, 229), "dot": (255, 190, 214), "ink": (122, 28, 72), "accent": (255, 255, 255)}
BLUE = {"bg": (210, 232, 255), "dot": (186, 216, 250), "ink": (29, 79, 216), "accent": (255, 255, 255)}
IVORY = {"bg": (250, 246, 240), "dot": (238, 228, 214), "ink": (92, 70, 48), "accent": (214, 180, 120)}
SAGE = {"bg": (222, 236, 224), "dot": (204, 224, 207), "ink": (34, 92, 60), "accent": (255, 255, 255)}

# (frame name, format id, preset id from shared/layouts.json, style, title, line under the title)
PACKS = [
    {"name": "Demo · Klasik", "description": "Kertas krem, gratis untuk semua paket", "price": 0, "status": "aktif", "frames": [
        ("Krem Strip", "4r-strip", "4-kembar", CREAM, "jepret", "demo · klasik"),
        ("Krem Grid", "4r", "grid-2x2", CREAM, "jepret", "demo · klasik"),
    ]},
    {"name": "Demo · Pastel", "description": "Pink & biru muda buat wisuda dan ulang tahun", "price": 10000, "status": "aktif", "frames": [
        ("Pastel Strip", "4r-strip", "3-kembar", PINK, "happy day!", "demo · pastel"),
        ("Pastel Polaroid", "polaroid-5r", "polaroid", BLUE, "hari ini", "demo · pastel"),
    ]},
    {"name": "Demo · Wedding", "description": "5R landscape dengan nama pengantin", "price": 25000, "status": "aktif", "frames": [
        ("Rani & Dimas", "5r-landscape", "besar-2-kecil", IVORY, "Rani & Dimas", "18 · 10 · 2026 · the wedding"),
        ("Wedding 2 Foto", "5r-landscape", "2-foto", IVORY, "Nama & Nama", "tanggal · tempat"),
    ]},
    {"name": "Demo · Draft", "description": "Contoh pack draft: tidak tampil di booth", "price": 15000, "status": "draft", "frames": [
        ("Sage Grid", "5r", "grid-2x2", SAGE, "draft", "tidak tampil di booth"),
    ]},
]
PACKAGES = [
    {"name": "Demo Basic", "price": 25000, "prints_included": 1, "extra_print_price": 10000, "max_prints": 3},
    {"name": "Demo Premium", "price": 45000, "prints_included": 2, "extra_print_price": 10000, "max_prints": 5},
]


class SeedError(RuntimeError):
    pass


# ---------------- artwork ----------------
def _font(size: int) -> ImageFont.FreeTypeFont:
    return ImageFont.load_default(size=size)


def _text_areas(fmt: dict, slots: list[dict]) -> list[tuple[int, int, int, int]]:
    """Where the title goes: the wedding text band, else the paper under the lowest hole (per strip)."""
    if fmt.get("text"):
        t = fmt["text"]
        return [(t["x"], t["y"], t["w"], t["h"])]
    top = max(s["y"] + s["h"] for s in slots) + 16
    bottom = fmt["h"] - 40
    cut = fmt.get("cut_x")
    halves = [(0, cut), (cut, fmt["w"] - cut)] if cut else [(0, fmt["w"])]
    return [(x, top, w, bottom - top) for x, w in halves]


def draw_frame(fmt: dict, preset: dict, style: dict, title: str, sub: str) -> bytes:
    """Polka-dot paper, ink border round every hole, title underneath; holes fully transparent."""
    W, H = fmt["w"], fmt["h"]
    im = Image.new("RGBA", (W, H), style["bg"] + (255,))
    d = ImageDraw.Draw(im)
    step = max(W, H) // 24
    r = step // 7
    for row, y in enumerate(range(step // 2, H, step)):
        for x in range(step // 2 + (row % 2) * step // 2, W, step):
            d.ellipse((x - r, y - r, x + r, y + r), fill=style["dot"])
    slots = preset["slots"]
    for s in slots:
        d.rectangle((s["x"] - 8, s["y"] - 8, s["x"] + s["w"] + 7, s["y"] + s["h"] + 7), fill=style["ink"])
    for s in slots:
        d.rectangle((s["x"], s["y"], s["x"] + s["w"] - 1, s["y"] + s["h"] - 1), fill=(0, 0, 0, 0))

    for x, y, w, h in _text_areas(fmt, slots):
        size = int(h * 0.42)
        font = _font(size)
        while size > 16 and d.textlength(title, font=font) > w * 0.8:
            size -= 4
            font = _font(size)
        cx, cy = x + w / 2, y + h * 0.42
        d.text((cx + size * 0.05, cy + size * 0.05), title, fill=style["accent"], font=font, anchor="mm")
        d.text((cx, cy), title, fill=style["ink"], font=font, anchor="mm")
        d.text((cx, y + h * 0.84), sub.upper(), fill=style["ink"], font=_font(max(14, size // 3)), anchor="mm")

    buf = io.BytesIO()
    im.save(buf, "PNG")
    return buf.getvalue()


# ---------------- admin API over HTTP ----------------
def _multipart(fields: dict, files: dict) -> tuple[bytes, str]:
    boundary = secrets.token_hex(16)
    out = io.BytesIO()
    for k, v in fields.items():
        out.write(f'--{boundary}\r\nContent-Disposition: form-data; name="{k}"\r\n\r\n{v}\r\n'.encode())
    for k, (name, content, ctype) in files.items():
        out.write(f'--{boundary}\r\nContent-Disposition: form-data; name="{k}"; filename="{name}"\r\nContent-Type: {ctype}\r\n\r\n'.encode())
        out.write(content + b"\r\n")
    out.write(f"--{boundary}--\r\n".encode())
    return out.getvalue(), f"multipart/form-data; boundary={boundary}"


class Api:
    """Admin API client: cookie session plus the CSRF header the dashboard sends.

    Called as api(method, path, payload=None, files=None): payload is the JSON body, or the
    form fields when files are attached.
    """

    def __init__(self, base_url: str):
        self.base = base_url.rstrip("/")
        self.opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))

    def __call__(self, method: str, path: str, payload: dict | None = None, files: dict | None = None):
        headers = {"X-Requested-With": "jepret", "User-Agent": "jepret-seed-demo"}
        body = None
        if files:
            body, headers["Content-Type"] = _multipart(payload or {}, files)
        elif payload is not None:
            body, headers["Content-Type"] = json.dumps(payload).encode(), "application/json"
        req = urllib.request.Request(self.base + path, data=body, method=method, headers=headers)
        try:
            with self.opener.open(req, timeout=120) as r:
                return json.loads(r.read() or b"null")
        except urllib.error.HTTPError as e:
            try:
                detail = json.loads(e.read()).get("detail")
            except (ValueError, AttributeError):
                detail = e.reason
            raise SeedError(f"{method} {path} → {e.code}: {detail}") from None
        except urllib.error.URLError as e:
            raise SeedError(f"Tidak bisa menghubungi {self.base}: {e.reason}") from None


# ---------------- seeding ----------------
def remove(api, log=print) -> None:
    for p in api("GET", "/api/admin/packs"):
        if p["name"].startswith(PACK_PREFIX):
            api("DELETE", f"/api/admin/packs/{p['id']}")
            log(f"- pack {p['name']} dihapus ({len(p['frames'])} frame)")
    for p in api("GET", "/api/admin/packages"):
        if p["name"].startswith(PACKAGE_PREFIX):
            api("DELETE", f"/api/admin/packages/{p['id']}")
            log(f"- paket {p['name']} dihapus")


def seed(api, log=print) -> None:
    """Replace the demo packs, frames and packages. `api` is logged in already."""
    remove(api, log)
    formats = {f["id"]: f for f in api("GET", "/api/layouts")["formats"]}
    for spec in PACKS:
        pack = api("POST", "/api/admin/packs", {k: spec[k] for k in ("name", "description", "price", "status")})
        for name, fmt_id, preset_id, style, title, sub in spec["frames"]:
            fmt = formats[fmt_id]
            preset = next(p for p in fmt["presets"] if p["id"] == preset_id)
            png = draw_frame(fmt, preset, style, title, sub)
            f = api("POST", "/api/admin/frames", {"pack_id": pack["id"], "format": fmt_id, "name": name},
                    files={"file": (f"{fmt_id}.png", png, "image/png")})
            api("PATCH", f"/api/admin/frames/{f['id']}", {"status": "aktif"})
            log(f"  frame {name} · {fmt['name']} · {f['n_photos']} foto")
        price = f"Rp {spec['price']:,}".replace(",", ".") if spec["price"] else "gratis"
        log(f"+ pack {spec['name']} ({price}, {spec['status']})")
    for spec in PACKAGES:
        api("POST", "/api/admin/packages", spec)
        log(f"+ paket {spec['name']}")
