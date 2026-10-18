import io
import json

import pytest
from fastapi.testclient import TestClient
from PIL import Image, ImageDraw

from app import frames as framelib
from app.auth import Auth, hash_password
from app.config import ROOT, Settings
from app.main import create_app

PASSWORD = "rahasia-tes-123"
H = {"X-Requested-With": "jepret"}
FORMATS = {f["id"]: f for f in json.loads((ROOT / "shared" / "layouts.json").read_text())["formats"]}


def jpeg(w=640, h=480) -> bytes:
    buf = io.BytesIO()
    Image.new("RGB", (w, h), (30, 80, 200)).save(buf, "JPEG")
    return buf.getvalue()


def frame_png(fmt_id="4r-strip", preset_id="4-kembar", size=None, alpha=True, extra_hole=None) -> bytes:
    fmt = FORMATS[fmt_id]
    preset = next(p for p in fmt["presets"] if p["id"] == preset_id)
    im = Image.new("RGBA", (fmt["w"], fmt["h"]), (255, 61, 139, 255))
    d = ImageDraw.Draw(im)
    for s in preset["slots"] + ([extra_hole] if extra_hole else []):
        d.rectangle((s["x"], s["y"], s["x"] + s["w"] - 1, s["y"] + s["h"] - 1), fill=(0, 0, 0, 0))
    if size:
        im = im.resize(size)
    if not alpha:
        im = im.convert("RGB")
    buf = io.BytesIO()
    im.save(buf, "PNG")
    return buf.getvalue()


@pytest.fixture()
def settings(tmp_path):
    static = tmp_path / "dist"
    static.mkdir()
    return Settings(data_dir=tmp_path / "data", static_dir=static, public_base_url="https://booth.test",
                    admin_user="admin", admin_hash=hash_password(PASSWORD))


@pytest.fixture()
def client(settings):
    with TestClient(create_app(settings)) as c:
        yield c


@pytest.fixture()
def admin(client):
    r = client.post("/api/admin/login", json={"username": "admin", "password": PASSWORD}, headers=H)
    assert r.status_code == 200, r.text
    return client


def make_pack(c, **kw):
    r = c.post("/api/admin/packs", json={"name": "Pack Uji", "price": 25000, **kw}, headers=H)
    assert r.status_code == 201, r.text
    return r.json()


def upload_frame(c, pack_id, png=None, fmt="4r-strip", name="Pink Riso"):
    return c.post("/api/admin/frames", data={"pack_id": pack_id, "format": fmt, "name": name},
                  files={"file": ("f.png", png or frame_png(), "image/png")}, headers=H)


def live_frame(c, **kw):
    pack = make_pack(c, status="aktif")
    f = upload_frame(c, pack["id"], **kw).json()
    assert c.patch(f"/api/admin/frames/{f['id']}", json={"status": "aktif"}, headers=H).status_code == 200
    return f


# ---------------- auth ----------------
def test_admin_routes_need_login(client):
    assert client.get("/api/admin/packs").status_code == 401
    assert client.get("/api/admin/me").status_code == 401


def test_wrong_password_is_rejected(client):
    r = client.post("/api/admin/login", json={"username": "admin", "password": "salah"}, headers=H)
    assert r.status_code == 401
    assert "pb_admin" not in r.cookies


def test_login_needs_csrf_header(client):
    r = client.post("/api/admin/login", json={"username": "admin", "password": PASSWORD})
    assert r.status_code == 403


def test_mutations_need_csrf_header_even_when_logged_in(admin):
    assert admin.get("/api/admin/me").json() == {"user": "admin"}
    assert admin.post("/api/admin/packs", json={"name": "x"}).status_code == 403


def test_login_without_configured_admin_explains_setup(tmp_path):
    s = Settings(data_dir=tmp_path / "d", static_dir=tmp_path, admin_hash="")
    with TestClient(create_app(s)) as c:
        r = c.post("/api/admin/login", json={"username": "admin", "password": "x"}, headers=H)
    assert r.status_code == 503
    assert "set-admin" in r.json()["detail"]


def test_new_password_invalidates_old_cookies():
    a = Auth(b"k" * 32, "admin", hash_password("pertama-123"), 14)
    token, _ = a.issue()
    assert a.valid(token)
    b = Auth(b"k" * 32, "admin", hash_password("kedua-12345"), 14)
    assert not b.valid(token)
    assert not a.valid(token + "x")


def test_logout_clears_cookie(admin):
    admin.post("/api/admin/logout", headers=H)
    assert admin.get("/api/admin/me").status_code == 401


# ---------------- packs + frames ----------------
def test_pack_crud(admin):
    p = make_pack(admin)
    assert p["status"] == "draft" and p["frames"] == []
    r = admin.patch(f"/api/admin/packs/{p['id']}", json={"name": "Pack X", "status": "aktif"}, headers=H)
    assert r.json()["name"] == "Pack X" and r.json()["status"] == "aktif"
    assert [x["id"] for x in admin.get("/api/admin/packs").json()] == [p["id"]]
    assert admin.delete(f"/api/admin/packs/{p['id']}", headers=H).status_code == 200
    assert admin.get("/api/admin/packs").json() == []


def test_upload_detects_twin_strips(admin):
    pack = make_pack(admin)
    r = upload_frame(admin, pack["id"])
    assert r.status_code == 201, r.text
    f = r.json()
    assert f["status"] == "draft" and f["format"] == "4r-strip"
    assert len(f["slots"]) == 8 and f["n_photos"] == 4
    assert [s["photo"] for s in f["slots"]] == [1, 2, 3, 4, 1, 2, 3, 4]
    assert f["slots"][0] == {"x": 40, "y": 40, "w": 520, "h": 390, "photo": 1}
    assert any("kembar" in i["text"] for i in f["issues"])


def test_upload_rescales_double_resolution(admin):
    pack = make_pack(admin)
    f = upload_frame(admin, pack["id"], png=frame_png(size=(2400, 3600))).json()
    assert f["w"] == 1200 and f["h"] == 1800
    assert f["slots"][0]["w"] == pytest.approx(520, abs=2)


@pytest.mark.parametrize(
    "png, needle",
    [
        (frame_png(size=(1800, 1200)), "terputar"),
        (frame_png(alpha=False), "transparansi"),
        (b"bukan png", "PNG"),
        (frame_png(extra_hole={"x": 500, "y": 1680, "w": 200, "h": 100, "photo": 5}), "garis potong"),
    ],
)
def test_upload_rejects_unusable_files(admin, png, needle):
    pack = make_pack(admin)
    r = upload_frame(admin, pack["id"], png=png)
    assert r.status_code == 422
    assert needle in r.json()["detail"]


def test_hole_in_wedding_text_band_is_flagged(admin):
    pack = make_pack(admin)
    hole = {"x": 300, "y": 1200, "w": 600, "h": 200, "photo": 4}
    f = upload_frame(admin, pack["id"], fmt="5r-landscape",
                     png=frame_png("5r-landscape", "besar-2-kecil", extra_hole=hole)).json()
    assert f["n_photos"] == 4
    assert any("area tulisan" in i["text"] and i["level"] == "warn" for i in f["issues"])
    clean = upload_frame(admin, pack["id"], fmt="5r-landscape", png=frame_png("5r-landscape", "besar-2-kecil")).json()
    # the big photo is Foto 1, then the two small ones top to bottom
    assert [(s["x"], s["y"], s["photo"]) for s in clean["slots"]] == [(60, 60, 1), (1503, 60, 2), (1503, 605, 3)]
    assert not any("area tulisan" in i["text"] for i in clean["issues"])


def test_guides_round_trip_through_the_detector(admin):
    """Every starter template we hand out must upload cleanly and give back its own slots."""
    for fmt in FORMATS.values():
        for preset in fmt["presets"]:
            r = admin.get(f"/api/admin/guides/{fmt['id']}/{preset['id']}.png")
            assert r.status_code == 200
            a = framelib.analyze(r.content, fmt)
            assert a.ok, (fmt["id"], preset["id"], a.issues)
            got = sorted((s["x"], s["y"], s["w"], s["h"]) for s in a.slots)
            want = sorted((s["x"], s["y"], s["w"], s["h"]) for s in preset["slots"])
            assert got == want, (fmt["id"], preset["id"])
            # Same holes can mean "twin strips" or "all different"; the PNG can't tell, so the
            # detector picks twins and the dashboard lets the admin switch.
            photos = [s["photo"] for s in sorted(a.slots, key=lambda s: (s["x"], s["y"]))]
            want_photos = [s["photo"] for s in sorted(preset["slots"], key=lambda s: (s["x"], s["y"]))]
            half = len(photos) // 2
            assert photos == want_photos or (fmt["cut_x"] and photos[:half] == photos[half:]), (fmt["id"], preset["id"])


def test_draft_frames_are_private_until_live(admin, client):
    pack = make_pack(admin)
    f = upload_frame(admin, pack["id"]).json()
    assert admin.get(f["preview"]).status_code == 200
    admin.post("/api/admin/logout", headers=H)
    assert client.get(f["url"]).status_code == 404
    assert client.get("/api/booth").json()["frames"] == []


def test_live_frame_is_public_and_listed_for_booth(admin):
    f = live_frame(admin)
    booth = admin.get("/api/booth").json()
    assert [x["id"] for x in booth["frames"]] == [f["id"]]
    admin.post("/api/admin/logout", headers=H)
    r = admin.get(f["url"])
    assert r.status_code == 200 and r.headers["content-type"] == "image/png"
    assert admin.get(f"/api/frames/{f['id']}/../secret.key").status_code == 404


def test_photo_numbers_can_be_remapped(admin):
    pack = make_pack(admin)
    f = upload_frame(admin, pack["id"]).json()
    r = admin.patch(f"/api/admin/frames/{f['id']}", json={"photos": [1, 2, 3, 4, 5, 6, 7, 8]}, headers=H)
    assert r.json()["n_photos"] == 8
    r = admin.patch(f"/api/admin/frames/{f['id']}", json={"photos": [1, 1, 3, 3, 1, 1, 3, 3]}, headers=H)
    assert r.status_code == 422


def test_deleting_pack_removes_frame_files(admin, settings):
    pack = make_pack(admin)
    f = upload_frame(admin, pack["id"]).json()
    assert (settings.frames_dir / f["id"] / "frame.png").is_file()
    admin.delete(f"/api/admin/packs/{pack['id']}", headers=H)
    assert not (settings.frames_dir / f["id"]).exists()


# ---------------- packages ----------------
def package(c, **kw):
    body = {"name": "Fast Snap", "price": 35000, "prints_included": 1, "extra_print_price": 20000, "max_prints": 5, **kw}
    return c.post("/api/admin/packages", json=body, headers=H)


def test_package_crud_and_validation(admin):
    assert package(admin, max_prints=0).status_code == 422
    p = package(admin).json()
    assert p["active"] is True
    assert admin.patch(f"/api/admin/packages/{p['id']}", json={"max_prints": 0}, headers=H).status_code == 422
    r = admin.patch(f"/api/admin/packages/{p['id']}", json={"active": False}, headers=H)
    assert r.json()["active"] is False
    assert admin.get("/api/booth").json()["packages"] == []
    assert admin.delete(f"/api/admin/packages/{p['id']}", headers=H).status_code == 200


# ---------------- booth sessions using frames + packages ----------------
def session(c, n_shots=4, **data):
    files = [("strip", ("strip.jpg", jpeg(1200, 1800), "image/jpeg"))]
    files += [("shots", (f"s{i}.jpg", jpeg(), "image/jpeg")) for i in range(n_shots)]
    return c.post("/api/sessions", data=data, files=files)


def test_session_with_uploaded_frame(admin):
    f = live_frame(admin)
    r = session(admin, template=f["id"])
    assert r.status_code == 201, r.text
    s = r.json()
    assert s["layout"] == "4r-strip" and s["template"] == f["id"] and s["layout_name"] == "Pink Riso"
    assert session(admin, n_shots=5, template=f["id"]).status_code == 422
    admin.patch(f"/api/admin/frames/{f['id']}", json={"status": "draft"}, headers=H)
    assert session(admin, template=f["id"]).status_code == 422


def test_session_with_package_prices_extra_prints(admin):
    p = package(admin).json()
    s = session(admin, layout="strip4", frame="pink", package=p["id"], prints=3).json()
    assert s["prints"] == 3 and s["total"] == 35000 + 2 * 20000
    s = session(admin, layout="strip4", frame="pink", package=p["id"]).json()
    assert s["prints"] == 1 and s["total"] == 35000
    assert session(admin, layout="strip4", frame="pink", package=p["id"], prints=6).status_code == 422
    admin.patch(f"/api/admin/packages/{p['id']}", json={"active": False}, headers=H)
    assert session(admin, layout="strip4", frame="pink", package=p["id"]).status_code == 422


def test_builtin_session_still_needs_layout_and_frame(client):
    assert session(client).status_code == 422
    assert session(client, layout="strip4").status_code == 422
    r = session(client, layout="strip4", frame="pink")
    assert r.status_code == 201 and r.json()["layout_name"] == "Strip 4"
