import asyncio
import contextlib
import io
import json
import logging
import re
from datetime import timedelta
from typing import Annotated

import segno
from fastapi import FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles
from starlette.exceptions import HTTPException as StarletteHTTPException

from . import media
from .admin import create_router
from .auth import Auth, load_secret
from .catalog import Catalog
from .config import Settings
from .store import Session, SessionStore

log = logging.getLogger("photobox")

MEDIA_NAME = re.compile(r"^(strip|anim|shot-[1-9])\.(jpg|gif)$")


def create_app(settings: Settings | None = None) -> FastAPI:
    settings = settings or Settings()
    catalog = json.loads(settings.layouts_file.read_text())
    layouts = {l["id"]: l for l in catalog["layouts"]}
    frames = {f["id"] for f in catalog["frames"]}
    filters = {f["id"] for f in catalog["filters"]}
    formats = {f["id"]: f for f in catalog["formats"]}

    @contextlib.asynccontextmanager
    async def lifespan(app: FastAPI):
        store = SessionStore(settings.db_path, settings.media_dir, timedelta(days=settings.retention_days))
        app.state.store = store
        app.state.catalog = Catalog(settings.db_path, settings.frames_dir)
        app.state.auth = Auth(load_secret(settings.secret_path), settings.admin_user, settings.admin_hash, settings.admin_session_days)

        async def janitor():
            while True:
                n = await asyncio.to_thread(store.purge_expired)
                if n:
                    log.info("purged %d expired sessions", n)
                await asyncio.sleep(3600)

        task = asyncio.create_task(janitor())
        yield
        task.cancel()
        store.close()
        app.state.catalog.close()

    app = FastAPI(title="photobox", lifespan=lifespan, docs_url="/api/docs", openapi_url="/api/openapi.json", redoc_url=None)

    def layout_name(request: Request, s: Session) -> str:
        if s.template:
            f = request.app.state.catalog.frame(s.template)
            if f:
                return f["name"]
            return formats[s.layout]["name"] if s.layout in formats else "Frame"
        return layouts[s.layout]["name"] if s.layout in layouts else s.layout

    def public(s: Session, request: Request) -> dict:
        base = f"/media/{s.code}"
        return {
            "code": s.code,
            "url": f"{settings.public_base_url}/s/{s.code}",
            "layout": s.layout,
            "layout_name": layout_name(request, s),
            "template": s.template,
            "prints": s.prints,
            "frame": s.frame,
            "filter": s.filter,
            "created_at": s.created_at.isoformat(),
            "expires_at": s.expires_at.isoformat(),
            "files": {
                "strip": f"{base}/strip.jpg",
                "gif": f"{base}/anim.gif" if s.has_gif else None,
                "shots": [f"{base}/shot-{i}.jpg" for i in range(1, s.n_shots + 1)],
                "qr": f"/api/sessions/{s.code}/qr.svg",
            },
        }

    def lookup(request: Request, code: str) -> Session:
        s = request.app.state.store.get(code.upper())
        if s is None:
            raise HTTPException(404, "Sesi tidak ditemukan atau sudah kedaluwarsa")
        return s

    async def read_limited(f: UploadFile) -> bytes:
        data = await f.read(settings.max_file_bytes + 1)
        if len(data) > settings.max_file_bytes:
            raise HTTPException(413, f"{f.filename} lebih dari {settings.max_file_bytes // 2**20} MB")
        return data

    @app.get("/api/health")
    def health():
        return {"ok": True}

    @app.get("/api/layouts")
    def get_layouts():
        return catalog

    @app.post("/api/sessions", status_code=201)
    async def create_session(
        request: Request,
        strip: Annotated[UploadFile, File(description="Hasil komposisi akhir (JPEG/PNG/WEBP)")],
        shots: Annotated[list[UploadFile], File(description="Foto mentah per jepretan, urut")],
        layout: Annotated[str | None, Form(description="Layout bawaan; diabaikan kalau `template` diisi")] = None,
        frame: Annotated[str | None, Form(description="Warna kertas layout bawaan")] = None,
        filter: Annotated[str, Form()] = "normal",
        template: Annotated[str | None, Form(description="ID frame upload dari dashboard")] = None,
        package: Annotated[int | None, Form(description="ID paket harga yang dipilih tamu")] = None,
        prints: Annotated[int | None, Form(ge=0, le=20, description="Jumlah lembar yang dicetak")] = None,
    ):
        cat: Catalog = request.app.state.catalog
        pack_price = 0
        if template:
            tpl = cat.live_frame(template)
            if tpl is None:
                raise HTTPException(422, "frame tidak tersedia")
            layout, frame, max_shots = tpl["format"], tpl["id"], tpl["n_photos"]
            pack_price = tpl["pack_price"]
        else:
            spec = layouts.get(layout or "")
            if spec is None:
                raise HTTPException(422, "layout tidak dikenal")
            if frame not in frames:
                raise HTTPException(422, "frame tidak dikenal")
            max_shots = spec["shots"]
        if filter not in filters:
            raise HTTPException(422, "filter tidak dikenal")
        if not 1 <= len(shots) <= max_shots:
            raise HTTPException(422, f"layout {layout} butuh 1–{max_shots} foto")
        total = None
        if package is not None:
            pk = cat.package(package)
            if pk is None or not pk["active"]:
                raise HTTPException(422, "paket tidak tersedia")
            if prints is None:
                prints = pk["prints_included"]
            if prints > pk["max_prints"]:
                raise HTTPException(422, f"paket {pk['name']} maksimal {pk['max_prints']} cetak")
            total = pk["price"] + max(0, prints - pk["prints_included"]) * pk["extra_print_price"]
        # A paid pack is charged on top of the package (or alone when the booth has no packages).
        if pack_price:
            total = (total or 0) + pack_price

        strip_bytes = await read_limited(strip)
        shot_bytes = [await read_limited(f) for f in shots]

        def process(code: str) -> bool:
            folder = settings.media_dir / code
            strip_img = media.decode(strip_bytes, settings.max_strip_px)
            shot_imgs = [media.decode(b, settings.max_strip_px) for b in shot_bytes]
            media.save_jpeg(strip_img, folder / "strip.jpg")
            for i, img in enumerate(shot_imgs, 1):
                media.save_jpeg(img, folder / f"shot-{i}.jpg", settings.shot_long_side)
            if len(shot_imgs) > 1:
                media.save_gif(shot_imgs, folder / "anim.gif", settings.gif_width)
                return True
            return False

        store: SessionStore = request.app.state.store
        code = store.reserve_code()
        try:
            has_gif = await asyncio.to_thread(process, code)
        except media.BadImage as e:
            store.release(code)
            raise HTTPException(422, str(e))
        except BaseException:
            store.release(code)
            raise
        s = store.add(code, layout, frame, filter, len(shots), has_gif, template or None, package, prints, total)
        return {**public(s, request), "total": total}

    @app.get("/api/sessions/{code}")
    def get_session(request: Request, code: str):
        return public(lookup(request, code), request)

    @app.get("/api/sessions/{code}/qr.svg")
    def qr(request: Request, code: str):
        s = lookup(request, code)
        buf = io.BytesIO()
        segno.make(f"{settings.public_base_url}/s/{s.code}", error="m").save(
            buf, kind="svg", scale=10, border=2, dark="#16110e", light="#ffffff", xmldecl=False, svgns=True
        )
        return Response(buf.getvalue(), media_type="image/svg+xml", headers={"Cache-Control": "public, max-age=86400"})

    @app.get("/media/{code}/{name}")
    def get_media(request: Request, code: str, name: str, dl: int = 0):
        if not MEDIA_NAME.fullmatch(name):
            raise HTTPException(404)
        s = lookup(request, code)
        path = settings.media_dir / s.code / name
        if not path.is_file():
            raise HTTPException(404)
        headers = {"Cache-Control": "private, max-age=3600"}
        if dl:
            return FileResponse(path, headers=headers, filename=f"{settings.brand}-{s.code}-{name}")
        return FileResponse(path, headers=headers)

    app.include_router(create_router(catalog, settings.max_frame_bytes))

    @app.exception_handler(StarletteHTTPException)
    async def http_error(request: Request, exc: StarletteHTTPException):
        # Unknown non-API paths fall through to the static site's 404 page.
        if exc.status_code == 404 and not request.url.path.startswith(("/api/", "/media/")):
            page = settings.static_dir / "404.html"
            if page.is_file():
                return FileResponse(page, status_code=404)
        return JSONResponse({"detail": exc.detail}, status_code=exc.status_code, headers=getattr(exc, "headers", None))

    # /s/<code> is the shareable result page; the page itself fetches /api/sessions/<code>.
    @app.get("/s/{code}")
    def result_page(code: str):
        return FileResponse(settings.static_dir / "s" / "index.html", headers={"Cache-Control": "no-cache"})

    if settings.static_dir.is_dir():
        app.mount("/", StaticFiles(directory=settings.static_dir, html=True), name="site")

    return app


app = create_app()
