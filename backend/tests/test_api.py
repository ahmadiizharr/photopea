import io
import re
from datetime import datetime, timedelta, timezone

import pytest
from fastapi.testclient import TestClient
from PIL import Image

from app.config import Settings
from app.main import create_app


def jpeg(w=640, h=480, color=(255, 61, 139), exif=None) -> bytes:
    buf = io.BytesIO()
    img = Image.new("RGB", (w, h), color)
    if exif is not None:
        img.save(buf, "JPEG", exif=exif)
    else:
        img.save(buf, "JPEG")
    return buf.getvalue()


@pytest.fixture()
def settings(tmp_path):
    static = tmp_path / "dist"
    (static / "s").mkdir(parents=True)
    (static / "index.html").write_text("<h1>landing</h1>")
    (static / "s" / "index.html").write_text("<h1>hasil</h1>")
    return Settings(
        data_dir=tmp_path / "data",
        static_dir=static,
        public_base_url="https://booth.test",
        retention_days=7,
    )


@pytest.fixture()
def client(settings):
    with TestClient(create_app(settings)) as c:
        yield c


def upload(client, layout="strip4", frame="pink", filter_="normal", shots=4, strip=None):
    files = [("strip", ("strip.jpg", strip or jpeg(600, 1800), "image/jpeg"))]
    files += [("shots", (f"s{i}.jpg", jpeg(color=(i * 40, 80, 200)), "image/jpeg")) for i in range(shots)]
    return client.post(
        "/api/sessions",
        data={"layout": layout, "frame": frame, "filter": filter_},
        files=files,
    )


def test_health(client):
    assert client.get("/api/health").json() == {"ok": True}


def test_layouts_come_from_shared_config(client):
    body = client.get("/api/layouts").json()
    assert {l["id"] for l in body["layouts"]} >= {"strip4", "strip3", "grid4", "polaroid"}
    assert {f["id"] for f in body["frames"]} >= {"pink", "kertas"}


def test_create_session_stores_strip_shots_and_gif(client, settings):
    r = upload(client)
    assert r.status_code == 201, r.text
    s = r.json()
    assert re.fullmatch(r"[23456789A-HJ-NP-Z]{6}", s["code"])
    assert s["url"] == f"https://booth.test/s/{s['code']}"
    assert s["files"]["strip"] == f"/media/{s['code']}/strip.jpg"
    assert len(s["files"]["shots"]) == 4
    assert s["files"]["gif"] == f"/media/{s['code']}/anim.gif"

    folder = settings.data_dir / "media" / s["code"]
    assert (folder / "strip.jpg").exists()
    assert (folder / "anim.gif").exists()
    with Image.open(folder / "anim.gif") as gif:
        assert gif.n_frames == 4


def test_single_shot_session_has_no_gif(client):
    s = upload(client, layout="polaroid", shots=1, strip=jpeg(1080, 1320)).json()
    assert s["files"]["gif"] is None
    assert len(s["files"]["shots"]) == 1


def test_get_session_roundtrip(client):
    code = upload(client).json()["code"]
    got = client.get(f"/api/sessions/{code}")
    assert got.status_code == 200
    assert got.json()["code"] == code
    assert got.json()["layout"] == "strip4"


def test_lowercase_code_is_accepted(client):
    code = upload(client).json()["code"]
    assert client.get(f"/api/sessions/{code.lower()}").status_code == 200


def test_qr_svg_points_at_result_page(client):
    code = upload(client).json()["code"]
    r = client.get(f"/api/sessions/{code}/qr.svg")
    assert r.status_code == 200
    assert r.headers["content-type"].startswith("image/svg+xml")
    assert r.text.lstrip().startswith("<?xml") or "<svg" in r.text


def test_media_is_served_and_downloadable(client):
    s = upload(client).json()
    r = client.get(s["files"]["strip"])
    assert r.status_code == 200
    assert r.headers["content-type"] == "image/jpeg"
    dl = client.get(s["files"]["strip"] + "?dl=1")
    assert "attachment" in dl.headers["content-disposition"]
    assert s["code"] in dl.headers["content-disposition"]


def test_media_rejects_path_tricks(client):
    code = upload(client).json()["code"]
    assert client.get(f"/media/{code}/..%2F..%2Fphotobox.db").status_code == 404
    assert client.get(f"/media/{code}/secret.txt").status_code == 404


def test_exif_is_stripped(client, settings):
    exif = Image.Exif()
    exif[0x010F] = "SpyCam"  # Make
    exif[0x8825] = {2: (1.0, 2.0, 3.0)}  # GPS
    s = upload(client, strip=jpeg(600, 1800, exif=exif)).json()
    with Image.open(settings.data_dir / "media" / s["code"] / "strip.jpg") as im:
        assert len(im.getexif()) == 0


@pytest.mark.parametrize(
    "kwargs",
    [
        {"layout": "nope"},
        {"frame": "nope"},
        {"filter_": "nope"},
        {"shots": 5},  # strip4 only takes 4
        {"shots": 0},
    ],
)
def test_rejects_bad_input(client, kwargs):
    assert upload(client, **kwargs).status_code == 422


def test_rejects_non_image(client):
    r = upload(client, strip=b"hello, not a jpeg")
    assert r.status_code == 422


def test_rejects_oversized_strip(client):
    r = upload(client, strip=jpeg(5000, 7000))
    assert r.status_code == 422


def test_unknown_or_malformed_code_is_404(client):
    assert client.get("/api/sessions/ZZZZZZ").status_code == 404
    assert client.get("/api/sessions/bad!code").status_code == 404
    assert client.get("/media/ZZZZZZ/strip.jpg").status_code == 404


def test_expired_session_is_gone_and_purged(client, settings):
    code = upload(client).json()["code"]
    app = client.app
    app.state.store.set_expiry(code, datetime.now(timezone.utc) - timedelta(minutes=1))
    assert client.get(f"/api/sessions/{code}").status_code == 404
    assert client.get(f"/media/{code}/strip.jpg").status_code == 404

    removed = app.state.store.purge_expired()
    assert removed == 1
    assert not (settings.data_dir / "media" / code).exists()


def test_result_page_route_serves_result_html(client):
    r = client.get("/s/ABC234")
    assert r.status_code == 200
    assert "hasil" in r.text


def test_landing_is_served(client):
    assert "landing" in client.get("/").text
