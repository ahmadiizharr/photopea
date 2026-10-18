"""Paying before the photos: /api/orders for the booth, vouchers and the kasir queue for the dashboard."""

import asyncio
from datetime import date
from typing import Annotated, Literal

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from pydantic import BaseModel, Field, model_validator

from .auth import require_admin
from .catalog import Catalog
from .orders import Orders, VoucherError

Rupiah = Annotated[int, Field(ge=0, le=100_000_000)]


class OrderIn(BaseModel):
    package: int | None = None
    template: str | None = Field(None, max_length=32)
    prints: int | None = Field(None, ge=0, le=20)
    voucher: str | None = Field(None, max_length=32)


class VoucherIn(BaseModel):
    kind: Literal["gratis", "potongan"] = "gratis"
    value: Rupiah = 0
    max_uses: int = Field(1, ge=1, le=10_000)
    expires_at: date | None = None
    note: str = Field("", max_length=80)
    count: int = Field(1, ge=1, le=200)
    code: str | None = Field(None, pattern=r"^[A-Za-z0-9-]{4,24}$")

    @model_validator(mode="after")
    def _check(self):
        if self.kind == "potongan" and self.value <= 0:
            raise ValueError("Isi besar potongan (lebih dari Rp 0)")
        if self.code and self.count != 1:
            raise ValueError("Kode sendiri hanya untuk satu voucher")
        return self


class VoucherPatch(BaseModel):
    active: bool | None = None
    note: str | None = Field(None, max_length=80)
    max_uses: int | None = Field(None, ge=1, le=10_000)


def public(o: dict) -> dict:
    """What the booth may see of its own order."""
    return {k: o[k] for k in ("id", "code", "status", "subtotal", "discount", "total", "prints", "voucher")}


def create_router() -> APIRouter:
    router = APIRouter()
    admin = [Depends(require_admin)]

    def cat(request: Request) -> Catalog:
        return request.app.state.catalog

    def pay(request: Request) -> Orders:
        return request.app.state.orders

    # ---------------- booth ----------------
    @router.post("/api/orders", status_code=201)
    async def create_order(body: OrderIn, request: Request):
        try:
            q = cat(request).quote(body.package, body.template, body.prints)
        except ValueError as e:
            raise HTTPException(422, str(e))
        try:
            o = pay(request).create(q, body.package, body.template, body.voucher)
        except VoucherError as e:
            await asyncio.sleep(0.4)  # slows down guessing codes
            raise HTTPException(422, str(e))
        return public(o)

    @router.get("/api/orders/{order_id}")
    def get_order(order_id: str, request: Request, response: Response):
        o = pay(request).order(order_id)
        if o is None:
            raise HTTPException(404, "Pesanan tidak ditemukan")
        response.headers["Cache-Control"] = "no-store"
        return public(o)

    @router.post("/api/orders/{order_id}/cancel")
    def cancel_order(order_id: str, request: Request):
        """The guest backed out before paying."""
        o = pay(request).cancel(order_id)
        if o is None:
            raise HTTPException(404, "Pesanan tidak ditemukan")
        return public(o)

    # ---------------- kasir ----------------
    @router.get("/api/admin/orders", dependencies=admin)
    def list_orders(request: Request):
        c = cat(request)
        packages = {p["id"]: p["name"] for p in c.packages()}
        names: dict[str, str] = {}
        out = []
        for o in pay(request).orders():
            if o["template"] and o["template"] not in names:
                f = c.frame(o["template"])
                names[o["template"]] = f["name"] if f else "Frame terhapus"
            out.append({**o, "package_name": packages.get(o["package_id"]), "frame_name": names.get(o["template"])})
        return out

    @router.post("/api/admin/orders/{order_id}/paid", dependencies=admin)
    def mark_paid(order_id: str, request: Request):
        o = pay(request).mark_paid(order_id)
        if o is None:
            raise HTTPException(404, "Pesanan tidak ditemukan")
        if o["status"] not in ("paid", "used"):
            raise HTTPException(409, "Pesanan ini sudah dibatalkan")
        return o

    @router.post("/api/admin/orders/{order_id}/cancel", dependencies=admin)
    def cancel_paid(order_id: str, request: Request):
        o = pay(request).cancel(order_id, ("pending", "paid"))
        if o is None:
            raise HTTPException(404, "Pesanan tidak ditemukan")
        if o["status"] == "used":
            raise HTTPException(409, "Pesanan ini sudah dipakai untuk foto")
        return o

    # ---------------- vouchers ----------------
    @router.get("/api/admin/vouchers", dependencies=admin)
    def list_vouchers(request: Request):
        return pay(request).vouchers()

    @router.post("/api/admin/vouchers", dependencies=admin, status_code=201)
    def create_vouchers(body: VoucherIn, request: Request):
        try:
            return pay(request).add_vouchers(
                body.kind, body.value if body.kind == "potongan" else 0, body.max_uses,
                body.expires_at.isoformat() if body.expires_at else None, body.note.strip(), body.count, body.code,
            )
        except VoucherError as e:
            raise HTTPException(409, str(e))

    @router.patch("/api/admin/vouchers/{code}", dependencies=admin)
    def update_voucher(code: str, body: VoucherPatch, request: Request):
        v = pay(request).update_voucher(code, body.model_dump(exclude_none=True))
        if v is None:
            raise HTTPException(404, "Voucher tidak ditemukan")
        return v

    @router.delete("/api/admin/vouchers/{code}", dependencies=admin)
    def delete_voucher(code: str, request: Request):
        if not pay(request).delete_voucher(code):
            raise HTTPException(404, "Voucher tidak ditemukan")
        return {"ok": True}

    return router
