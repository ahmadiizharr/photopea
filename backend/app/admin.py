"""Superadmin API (/api/admin/*) plus the public bits the booth reads (/api/booth, /api/frames/*)."""

import asyncio
from typing import Annotated, Literal

from fastapi import APIRouter, Depends, File, Form, HTTPException, Request, Response, UploadFile
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field, model_validator

from . import frames as framelib
from .auth import COOKIE, CSRF_HEADER, CSRF_VALUE, Auth, is_admin, require_admin
from .catalog import Catalog

Status = Literal["aktif", "draft"]
Name = Annotated[str, Field(min_length=1, max_length=40)]
Rupiah = Annotated[int, Field(ge=0, le=100_000_000)]


class LoginIn(BaseModel):
    username: str = Field(max_length=64)
    password: str = Field(max_length=256)


class PackIn(BaseModel):
    name: Name
    description: str = Field("", max_length=160)
    price: Rupiah = 0
    status: Status = "draft"


class PackPatch(BaseModel):
    name: Name | None = None
    description: str | None = Field(None, max_length=160)
    price: Rupiah | None = None
    status: Status | None = None
    sort: int | None = None


class FramePatch(BaseModel):
    name: Annotated[str, Field(min_length=1, max_length=60)] | None = None
    status: Status | None = None
    pack_id: str | None = None
    photos: list[Annotated[int, Field(ge=1, le=framelib.MAX_PHOTOS)]] | None = None


class PackageIn(BaseModel):
    name: Name
    price: Rupiah
    prints_included: int = Field(ge=0, le=20)
    extra_print_price: Rupiah = 0
    max_prints: int = Field(ge=0, le=20)
    active: bool = True

    @model_validator(mode="after")
    def _max_covers_included(self):
        if self.max_prints < self.prints_included:
            raise ValueError("Maks cetak tidak boleh lebih kecil dari cetak termasuk")
        return self


class PackagePatch(BaseModel):
    name: Name | None = None
    price: Rupiah | None = None
    prints_included: int | None = Field(None, ge=0, le=20)
    extra_print_price: Rupiah | None = None
    max_prints: int | None = Field(None, ge=0, le=20)
    active: bool | None = None
    sort: int | None = None


def create_router(catalog_json: dict, max_frame_bytes: int) -> APIRouter:
    formats = {f["id"]: f for f in catalog_json["formats"]}
    router = APIRouter()
    admin = [Depends(require_admin)]

    def cat(request: Request) -> Catalog:
        return request.app.state.catalog

    # ---------------- session ----------------
    @router.post("/api/admin/login")
    async def login(body: LoginIn, request: Request, response: Response):
        auth: Auth = request.app.state.auth
        if request.headers.get(CSRF_HEADER) != CSRF_VALUE:
            raise HTTPException(403, "Permintaan ditolak")
        if not auth.configured:
            raise HTTPException(503, "Akun superadmin belum diatur. Di server jalankan: python -m app.cli set-admin")
        if not await asyncio.to_thread(auth.check_login, body.username, body.password):
            await asyncio.sleep(0.6)
            raise HTTPException(401, "Username atau password salah")
        token, ttl = auth.issue()
        response.set_cookie(COOKIE, token, max_age=ttl, httponly=True, samesite="strict", path="/",
                            secure=request.url.scheme == "https")
        return {"user": auth.user}

    @router.post("/api/admin/logout")
    def logout(response: Response):
        response.delete_cookie(COOKIE, path="/")
        return {"ok": True}

    @router.get("/api/admin/me", dependencies=admin)
    def me(request: Request):
        return {"user": request.app.state.auth.user}

    # ---------------- packs ----------------
    @router.get("/api/admin/packs", dependencies=admin)
    def list_packs(request: Request):
        return cat(request).packs()

    @router.post("/api/admin/packs", dependencies=admin, status_code=201)
    def create_pack(body: PackIn, request: Request):
        return cat(request).add_pack(body.model_dump())

    @router.patch("/api/admin/packs/{pack_id}", dependencies=admin)
    def update_pack(pack_id: str, body: PackPatch, request: Request):
        p = cat(request).update_pack(pack_id, body.model_dump(exclude_none=True))
        if p is None:
            raise HTTPException(404, "Pack tidak ditemukan")
        return p

    @router.delete("/api/admin/packs/{pack_id}", dependencies=admin)
    def delete_pack(pack_id: str, request: Request):
        if not cat(request).delete_pack(pack_id):
            raise HTTPException(404, "Pack tidak ditemukan")
        return {"ok": True}

    # ---------------- frames ----------------
    @router.post("/api/admin/frames", dependencies=admin, status_code=201)
    async def upload_frame(
        request: Request,
        file: Annotated[UploadFile, File(description="PNG dengan lubang foto transparan")],
        pack_id: Annotated[str, Form()],
        format: Annotated[str, Form()],
        name: Annotated[str, Form(min_length=1, max_length=60)],
    ):
        c = cat(request)
        if c.pack(pack_id) is None:
            raise HTTPException(422, "Pack tidak ditemukan")
        fmt = formats.get(format)
        if fmt is None:
            raise HTTPException(422, "Ukuran cetak tidak dikenal")
        data = await file.read(max_frame_bytes + 1)
        if len(data) > max_frame_bytes:
            raise HTTPException(413, f"File lebih dari {max_frame_bytes // 2**20} MB")

        def work():
            a = framelib.analyze(data, fmt)
            if not a.ok:
                raise framelib.BadFrame(" ".join(i["text"] for i in a.issues if i["level"] == "error"))
            return a, framelib.save_png(a.image), framelib.preview(a.image, a.slots)

        try:
            a, png, prev = await asyncio.to_thread(work)
        except framelib.BadFrame as e:
            raise HTTPException(422, str(e))
        return c.add_frame(pack_id, name.strip(), fmt, a.slots, a.issues, png, prev)

    @router.patch("/api/admin/frames/{frame_id}", dependencies=admin)
    async def update_frame(frame_id: str, body: FramePatch, request: Request):
        c = cat(request)
        f = c.frame(frame_id)
        if f is None:
            raise HTTPException(404, "Frame tidak ditemukan")
        if body.pack_id is not None and c.pack(body.pack_id) is None:
            raise HTTPException(422, "Pack tidak ditemukan")
        slots = preview = None
        if body.photos is not None:
            if len(body.photos) != len(f["slots"]):
                raise HTTPException(422, "Jumlah nomor foto harus sama dengan jumlah lubang")
            used = set(body.photos)
            if used != set(range(1, max(used) + 1)):
                raise HTTPException(422, f"Nomor foto harus berurutan tanpa loncat (1 sampai {max(used)})")
            slots = [{**s, "photo": n} for s, n in zip(f["slots"], body.photos)]
            with framelib.Image.open(c.frame_path(frame_id, "frame.png")) as im:
                im.load()
                preview = await asyncio.to_thread(framelib.preview, im.convert("RGBA"), slots)
        return c.update_frame(frame_id, name=body.name, status=body.status, pack_id=body.pack_id, slots=slots, preview=preview)

    @router.delete("/api/admin/frames/{frame_id}", dependencies=admin)
    def delete_frame(frame_id: str, request: Request):
        if not cat(request).delete_frame(frame_id):
            raise HTTPException(404, "Frame tidak ditemukan")
        return {"ok": True}

    @router.get("/api/admin/guides/{format_id}/{preset_id}.png", dependencies=admin)
    async def guide(format_id: str, preset_id: str):
        fmt = formats.get(format_id)
        preset = next((p for p in fmt["presets"] if p["id"] == preset_id), None) if fmt else None
        if preset is None:
            raise HTTPException(404, "Template tidak ditemukan")
        png = await asyncio.to_thread(framelib.guide, fmt, preset)
        return Response(png, media_type="image/png", headers={
            "Content-Disposition": f'attachment; filename="jepret-template-{format_id}-{preset_id}.png"',
            "Cache-Control": "private, max-age=3600",
        })

    # ---------------- packages ----------------
    @router.get("/api/admin/packages", dependencies=admin)
    def list_packages(request: Request):
        return cat(request).packages()

    @router.post("/api/admin/packages", dependencies=admin, status_code=201)
    def create_package(body: PackageIn, request: Request):
        return cat(request).add_package(body.model_dump())

    @router.patch("/api/admin/packages/{package_id}", dependencies=admin)
    def update_package(package_id: int, body: PackagePatch, request: Request):
        c = cat(request)
        cur = c.package(package_id)
        if cur is None:
            raise HTTPException(404, "Paket tidak ditemukan")
        merged = {**cur, **body.model_dump(exclude_none=True)}
        if merged["max_prints"] < merged["prints_included"]:
            raise HTTPException(422, "Maks cetak tidak boleh lebih kecil dari cetak termasuk")
        return c.update_package(package_id, body.model_dump(exclude_none=True))

    @router.delete("/api/admin/packages/{package_id}", dependencies=admin)
    def delete_package(package_id: int, request: Request):
        if not cat(request).delete_package(package_id):
            raise HTTPException(404, "Paket tidak ditemukan")
        return {"ok": True}

    # ---------------- public: what the booth shows ----------------
    @router.get("/api/booth")
    def booth(request: Request, response: Response):
        c = cat(request)
        response.headers["Cache-Control"] = "no-store"
        return {"frames": c.live_frames(), "packages": c.packages(active_only=True)}

    @router.get("/api/frames/{frame_id}/{name}")
    def frame_file(frame_id: str, name: str, request: Request):
        if name not in ("frame.png", "preview.webp"):
            raise HTTPException(404)
        c = cat(request)
        live = c.is_live(frame_id)
        if not live and not is_admin(request):
            raise HTTPException(404)
        path = c.frame_path(frame_id, name)
        if not path.is_file():
            raise HTTPException(404)
        # frame.png never changes after upload; previews are versioned by ?v=
        cache = "public, max-age=86400" if live else "private, no-store"
        return FileResponse(path, headers={"Cache-Control": cache})

    return router
