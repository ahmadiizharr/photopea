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

    @contextlib.asynccontextmanager
    async def lifespan(app: FastAPI):
        store = SessionStore(settings.db_path, settings.media_dir, timedelta(days=settings.retention_days))
        app.state.store = store

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

    app = FastAPI(title="photobox", lifespan=lifespan, docs_url="/api/docs", openapi_url="/api/openapi.json", redoc_url=None)

    def public(s: Session) -> dict:
        base = f"/media/{s.code}"
        return {
            "code": s.code,
            "url": f"{settings.public_base_url}/s/{s.code}",
            "layout": s.layout,
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
        layout: Annotated[str, Form()],
        frame: Annotated[str, Form()],
        filter: Annotated[str, Form()] = "normal",
    ):
        spec = layouts.get(layout)
        if spec is None:
            raise HTTPException(422, "layout tidak dikenal")
        if frame not in frames:
            raise HTTPException(422, "frame tidak dikenal")
        if filter not in filters:
            raise HTTPException(422, "filter tidak dikenal")
        if not 1 <= len(shots) <= spec["shots"]:
            raise HTTPException(422, f"layout {layout} butuh 1–{spec['shots']} foto")

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
        s = store.add(code, layout, frame, filter, len(shots), has_gif)
        return public(s)

    @app.get("/api/sessions/{code}")
    def get_session(request: Request, code: str):
        return public(lookup(request, code))

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
