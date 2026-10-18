"""Paying before the photos: orders the booth creates and the vouchers that pay for them.

An order freezes what the guest chose (package, frame, prints) and its price. It stays `pending`
until the kasir marks it paid in the dashboard, or is `paid` straight away when a voucher covers
the whole price. A session uses a paid order exactly once (`used`). Same SQLite file as the rest.
"""

import secrets
import sqlite3
import threading
from datetime import datetime, timedelta, timezone
from pathlib import Path

WIB = timezone(timedelta(hours=7))  # voucher expiry dates are the booth's local dates
# Short codes get read aloud at the kasir: no 0/O, 1/I/L, 2/Z, 5/S, 8/B.
ORDER_ALPHABET = "ACDEFGHJKMNPQRTUVWXY34679"
VOUCHER_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"

SCHEMA = """
CREATE TABLE IF NOT EXISTS vouchers (
    code TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    value INTEGER NOT NULL DEFAULT 0,
    max_uses INTEGER NOT NULL DEFAULT 1,
    used INTEGER NOT NULL DEFAULT 0,
    active INTEGER NOT NULL DEFAULT 1,
    expires_at TEXT,
    note TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS orders (
    id TEXT PRIMARY KEY,
    code TEXT NOT NULL,
    package_id INTEGER,
    template TEXT,
    prints INTEGER NOT NULL DEFAULT 0,
    subtotal INTEGER NOT NULL,
    discount INTEGER NOT NULL DEFAULT 0,
    total INTEGER NOT NULL,
    voucher TEXT,
    status TEXT NOT NULL,
    session TEXT,
    created_at TEXT NOT NULL,
    paid_at TEXT
);
CREATE INDEX IF NOT EXISTS orders_status ON orders(status, created_at);
"""

VOUCHER_FIELDS = ("active", "note", "max_uses")


class VoucherError(ValueError):
    pass


def now() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat()


def normalize(code: str) -> str:
    return code.strip().upper().replace(" ", "")


class Orders:
    def __init__(self, db_path: Path):
        self._lock = threading.Lock()
        self._db = sqlite3.connect(db_path, check_same_thread=False)
        self._db.row_factory = sqlite3.Row
        self._db.execute("PRAGMA journal_mode=WAL")
        self._db.executescript(SCHEMA)
        self._db.commit()

    def close(self) -> None:
        with self._lock:  # never under a query still running in a worker thread
            self._db.close()

    def _q(self, sql: str, args: tuple = ()) -> list[sqlite3.Row]:
        with self._lock:
            return self._db.execute(sql, args).fetchall()

    def _w(self, sql: str, args: tuple = ()) -> int:
        with self._lock:
            cur = self._db.execute(sql, args)
            self._db.commit()
            return cur.rowcount

    # ---------- vouchers ----------
    @staticmethod
    def _voucher(row: sqlite3.Row) -> dict:
        v = dict(row)
        v["active"] = bool(v["active"])
        return v

    def vouchers(self) -> list[dict]:
        return [self._voucher(r) for r in self._q("SELECT * FROM vouchers ORDER BY created_at DESC, code")]

    def voucher(self, code: str) -> dict | None:
        rows = self._q("SELECT * FROM vouchers WHERE code = ?", (normalize(code),))
        return self._voucher(rows[0]) if rows else None

    def add_vouchers(self, kind: str, value: int, max_uses: int, expires_at: str | None, note: str,
                     count: int = 1, code: str | None = None, prefix: str = "") -> list[dict]:
        """`code` for one hand-picked voucher, else `count` random ones (8 characters after `prefix`)."""
        made = []
        with self._lock:
            for _ in range(count):
                while True:
                    c = normalize(code) if code else prefix + "".join(secrets.choice(VOUCHER_ALPHABET) for _ in range(8))
                    try:
                        self._db.execute(
                            "INSERT INTO vouchers (code, kind, value, max_uses, expires_at, note, created_at) VALUES (?,?,?,?,?,?,?)",
                            (c, kind, value, max_uses, expires_at, note, now()),
                        )
                    except sqlite3.IntegrityError:
                        if code:
                            raise VoucherError(f"Kode {c} sudah ada") from None
                        continue
                    made.append(c)
                    break
            self._db.commit()
        return [self.voucher(c) for c in made]

    def update_voucher(self, code: str, data: dict) -> dict | None:
        sets = {k: (int(v) if k == "active" else v) for k, v in data.items() if k in VOUCHER_FIELDS and v is not None}
        if sets:
            self._w(f"UPDATE vouchers SET {', '.join(f'{k} = ?' for k in sets)} WHERE code = ?", (*sets.values(), normalize(code)))
        return self.voucher(code)

    def delete_voucher(self, code: str) -> bool:
        return bool(self._w("DELETE FROM vouchers WHERE code = ?", (normalize(code),)))

    # ---------- orders ----------
    def order(self, order_id: str) -> dict | None:
        rows = self._q("SELECT * FROM orders WHERE id = ?", (order_id,))
        return dict(rows[0]) if rows else None

    def orders(self, limit: int = 60) -> list[dict]:
        """Waiting orders first (oldest on top, like a queue), then the latest others."""
        rows = self._q(
            """SELECT * FROM orders ORDER BY status = 'pending' DESC,
               CASE WHEN status = 'pending' THEN created_at END ASC, created_at DESC LIMIT ?""",
            (limit,),
        )
        return [dict(r) for r in rows]

    def create(self, quote: dict, package_id: int | None, template: str | None, voucher: str | None = None) -> dict:
        """Freeze a quote into an order, spending one use of `voucher` (VoucherError when it can't)."""
        subtotal = quote["total"]
        oid = secrets.token_urlsafe(12)
        with self._lock:
            discount, code_v = 0, None
            if voucher:
                code_v = normalize(voucher)
                row = self._db.execute("SELECT * FROM vouchers WHERE code = ?", (code_v,)).fetchone()
                today = datetime.now(WIB).date().isoformat()
                if row is None:
                    raise VoucherError("Kode voucher tidak dikenal")
                if not row["active"]:
                    raise VoucherError("Voucher ini sudah tidak berlaku")
                if row["expires_at"] and row["expires_at"] < today:
                    raise VoucherError("Voucher ini sudah kedaluwarsa")
                if row["used"] >= row["max_uses"]:
                    raise VoucherError("Voucher ini sudah habis dipakai")
                discount = subtotal if row["kind"] == "gratis" else min(row["value"], subtotal)
                self._db.execute("UPDATE vouchers SET used = used + 1 WHERE code = ?", (code_v,))
            total = subtotal - discount
            status = "paid" if total == 0 else "pending"
            pending = {r[0] for r in self._db.execute("SELECT code FROM orders WHERE status = 'pending'")}
            while True:
                code = "".join(secrets.choice(ORDER_ALPHABET) for _ in range(4))
                if code not in pending:
                    break
            t = now()
            self._db.execute(
                """INSERT INTO orders (id, code, package_id, template, prints, subtotal, discount, total, voucher, status, created_at, paid_at)
                   VALUES (?,?,?,?,?,?,?,?,?,?,?,?)""",
                (oid, code, package_id, template, quote["prints"] or 0, subtotal, discount, total, code_v, status, t,
                 t if status == "paid" else None),
            )
            self._db.commit()
        return self.order(oid)

    def mark_paid(self, order_id: str) -> dict | None:
        self._w("UPDATE orders SET status = 'paid', paid_at = ? WHERE id = ? AND status = 'pending'", (now(), order_id))
        return self.order(order_id)

    def cancel(self, order_id: str, statuses: tuple[str, ...] = ("pending",)) -> dict | None:
        """Cancel an order still in one of `statuses`; its voucher use is given back."""
        with self._lock:
            row = self._db.execute("SELECT * FROM orders WHERE id = ?", (order_id,)).fetchone()
            if row and row["status"] in statuses:
                self._db.execute("UPDATE orders SET status = 'cancelled' WHERE id = ?", (order_id,))
                if row["voucher"]:
                    self._db.execute("UPDATE vouchers SET used = MAX(0, used - 1) WHERE code = ?", (row["voucher"],))
                self._db.commit()
        return self.order(order_id)

    def claim(self, order_id: str, session_code: str) -> bool:
        """Spend a paid order on a session. False when it isn't paid or was spent already."""
        return bool(self._w("UPDATE orders SET status = 'used', session = ? WHERE id = ? AND status = 'paid'", (session_code, order_id)))

    def unclaim(self, order_id: str) -> None:
        self._w("UPDATE orders SET status = 'paid', session = NULL WHERE id = ? AND status = 'used'", (order_id,))

    def expire_pending(self, older_than: timedelta) -> int:
        """Cancel orders nobody paid for (guest walked away); their vouchers come back."""
        cutoff = (datetime.now(timezone.utc) - older_than).replace(microsecond=0).isoformat()
        ids = [r[0] for r in self._q("SELECT id FROM orders WHERE status = 'pending' AND created_at <= ?", (cutoff,))]
        for oid in ids:
            self.cancel(oid)
        return len(ids)
