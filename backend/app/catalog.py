"""Dashboard data: frame packs, uploaded frames, and the price packages shown in the booth.

Same SQLite file as the sessions; frame files live in frames/<id>/{frame.png,preview.webp}.
"""

import json
import secrets
import shutil
import sqlite3
import threading
from datetime import datetime, timezone
from pathlib import Path

ID_ALPHABET = "abcdefghijkmnpqrstuvwxyz23456789"


def new_id() -> str:
    return "".join(secrets.choice(ID_ALPHABET) for _ in range(8))


def now() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat()


SCHEMA = """
CREATE TABLE IF NOT EXISTS packs (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    price INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'draft',
    sort INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS frames (
    id TEXT PRIMARY KEY,
    pack_id TEXT NOT NULL REFERENCES packs(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    format TEXT NOT NULL,
    w INTEGER NOT NULL,
    h INTEGER NOT NULL,
    slots TEXT NOT NULL,
    issues TEXT NOT NULL DEFAULT '[]',
    status TEXT NOT NULL DEFAULT 'draft',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS frames_pack ON frames(pack_id);
CREATE TABLE IF NOT EXISTS packages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    price INTEGER NOT NULL,
    prints_included INTEGER NOT NULL,
    extra_print_price INTEGER NOT NULL,
    max_prints INTEGER NOT NULL,
    active INTEGER NOT NULL DEFAULT 1,
    sort INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
);
"""

PACK_FIELDS = ("name", "description", "price", "status", "sort")
PACKAGE_FIELDS = ("name", "price", "prints_included", "extra_print_price", "max_prints", "active", "sort")


class Catalog:
    def __init__(self, db_path: Path, frames_dir: Path):
        self.frames_dir = frames_dir
        frames_dir.mkdir(parents=True, exist_ok=True)
        self._lock = threading.Lock()
        self._db = sqlite3.connect(db_path, check_same_thread=False)
        self._db.row_factory = sqlite3.Row
        self._db.execute("PRAGMA journal_mode=WAL")
        self._db.execute("PRAGMA foreign_keys=ON")
        self._db.executescript(SCHEMA)
        self._db.commit()

    def close(self) -> None:
        self._db.close()

    def _q(self, sql: str, args: tuple = ()) -> list[sqlite3.Row]:
        with self._lock:
            return self._db.execute(sql, args).fetchall()

    def _w(self, sql: str, args: tuple = ()) -> int:
        with self._lock:
            cur = self._db.execute(sql, args)
            self._db.commit()
            return cur.lastrowid if cur.lastrowid else cur.rowcount

    # ---------- packs ----------
    def packs(self) -> list[dict]:
        packs = [dict(r) for r in self._q("SELECT * FROM packs ORDER BY sort, created_at")]
        frames = self.frames()
        for p in packs:
            p["frames"] = [f for f in frames if f["pack_id"] == p["id"]]
        return packs

    def pack(self, pack_id: str) -> dict | None:
        rows = self._q("SELECT * FROM packs WHERE id = ?", (pack_id,))
        if not rows:
            return None
        p = dict(rows[0])
        p["frames"] = self.frames(pack_id)
        return p

    def add_pack(self, data: dict) -> dict:
        pid = new_id()
        sort = self._q("SELECT COALESCE(MAX(sort), 0) + 1 FROM packs")[0][0]
        self._w(
            "INSERT INTO packs (id, name, description, price, status, sort, created_at) VALUES (?,?,?,?,?,?,?)",
            (pid, data["name"], data.get("description", ""), data.get("price", 0), data.get("status", "draft"), sort, now()),
        )
        return self.pack(pid)

    def update_pack(self, pack_id: str, data: dict) -> dict | None:
        sets = {k: v for k, v in data.items() if k in PACK_FIELDS and v is not None}
        if sets:
            self._w(f"UPDATE packs SET {', '.join(f'{k} = ?' for k in sets)} WHERE id = ?", (*sets.values(), pack_id))
        return self.pack(pack_id)

    def delete_pack(self, pack_id: str) -> bool:
        ids = [r[0] for r in self._q("SELECT id FROM frames WHERE pack_id = ?", (pack_id,))]
        n = self._w("DELETE FROM packs WHERE id = ?", (pack_id,))
        for fid in ids:
            shutil.rmtree(self.frames_dir / fid, ignore_errors=True)
        return bool(n)

    # ---------- frames ----------
    @staticmethod
    def _frame(row: sqlite3.Row) -> dict:
        f = dict(row)
        f["slots"] = json.loads(f["slots"])
        f["issues"] = json.loads(f["issues"])
        f["n_photos"] = max((s["photo"] for s in f["slots"]), default=0)
        f["url"] = f"/api/frames/{f['id']}/frame.png"
        f["preview"] = f"/api/frames/{f['id']}/preview.webp?v={f['updated_at'].replace(':', '').replace('-', '')[:15]}"
        return f

    def frames(self, pack_id: str | None = None) -> list[dict]:
        if pack_id:
            rows = self._q("SELECT * FROM frames WHERE pack_id = ? ORDER BY created_at", (pack_id,))
        else:
            rows = self._q("SELECT * FROM frames ORDER BY created_at")
        return [self._frame(r) for r in rows]

    def frame(self, frame_id: str) -> dict | None:
        rows = self._q("SELECT * FROM frames WHERE id = ?", (frame_id,))
        return self._frame(rows[0]) if rows else None

    def add_frame(self, pack_id: str, name: str, fmt: dict, slots: list[dict], issues: list[dict], png: bytes, preview: bytes) -> dict:
        fid = new_id()
        folder = self.frames_dir / fid
        folder.mkdir()
        try:
            (folder / "frame.png").write_bytes(png)
            (folder / "preview.webp").write_bytes(preview)
            t = now()
            self._w(
                "INSERT INTO frames (id, pack_id, name, format, w, h, slots, issues, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
                (fid, pack_id, name, fmt["id"], fmt["w"], fmt["h"], json.dumps(slots), json.dumps(issues), "draft", t, t),
            )
        except BaseException:
            shutil.rmtree(folder, ignore_errors=True)
            raise
        return self.frame(fid)

    def update_frame(self, frame_id: str, *, name=None, status=None, pack_id=None, slots=None, preview: bytes | None = None) -> dict | None:
        sets: dict = {}
        if name is not None:
            sets["name"] = name
        if status is not None:
            sets["status"] = status
        if pack_id is not None:
            sets["pack_id"] = pack_id
        if slots is not None:
            sets["slots"] = json.dumps(slots)
        if preview is not None:
            (self.frames_dir / frame_id / "preview.webp").write_bytes(preview)
        if sets or preview is not None:
            sets["updated_at"] = now()
            self._w(f"UPDATE frames SET {', '.join(f'{k} = ?' for k in sets)} WHERE id = ?", (*sets.values(), frame_id))
        return self.frame(frame_id)

    def delete_frame(self, frame_id: str) -> bool:
        n = self._w("DELETE FROM frames WHERE id = ?", (frame_id,))
        shutil.rmtree(self.frames_dir / frame_id, ignore_errors=True)
        return bool(n)

    def frame_path(self, frame_id: str, name: str) -> Path:
        return self.frames_dir / frame_id / name

    LIVE = """SELECT f.*, p.name AS pack_name, p.price AS pack_price FROM frames f JOIN packs p ON p.id = f.pack_id
              WHERE f.status = 'aktif' AND p.status = 'aktif'"""

    def live_frames(self) -> list[dict]:
        """Frames the booth may use: active frame in an active pack."""
        rows = self._q(self.LIVE + " ORDER BY p.sort, p.created_at, f.created_at")
        keys = ("id", "name", "pack_id", "pack_name", "pack_price", "format", "w", "h", "slots", "n_photos", "url", "preview")
        return [{k: f[k] for k in keys} for f in map(self._frame, rows)]

    def live_frame(self, frame_id: str) -> dict | None:
        """One frame the booth may use, with its pack's price; None when it or its pack is off."""
        rows = self._q(self.LIVE + " AND f.id = ?", (frame_id,))
        return self._frame(rows[0]) if rows else None

    def live_packs(self) -> list[dict]:
        """Active packs that have at least one active frame, in booth order."""
        rows = self._q(
            """SELECT id, name, description, price FROM packs p WHERE status = 'aktif'
               AND EXISTS (SELECT 1 FROM frames f WHERE f.pack_id = p.id AND f.status = 'aktif') ORDER BY sort, created_at"""
        )
        return [dict(r) for r in rows]

    def is_live(self, frame_id: str) -> bool:
        return bool(self._q(
            "SELECT 1 FROM frames f JOIN packs p ON p.id = f.pack_id WHERE f.id = ? AND f.status = 'aktif' AND p.status = 'aktif'",
            (frame_id,),
        ))

    # ---------- packages ----------
    @staticmethod
    def _package(row: sqlite3.Row) -> dict:
        p = dict(row)
        p["active"] = bool(p["active"])
        return p

    def packages(self, active_only: bool = False) -> list[dict]:
        where = "WHERE active = 1 " if active_only else ""
        return [self._package(r) for r in self._q(f"SELECT * FROM packages {where}ORDER BY sort, id")]

    def package(self, package_id: int) -> dict | None:
        rows = self._q("SELECT * FROM packages WHERE id = ?", (package_id,))
        return self._package(rows[0]) if rows else None

    def add_package(self, data: dict) -> dict:
        sort = self._q("SELECT COALESCE(MAX(sort), 0) + 1 FROM packages")[0][0]
        pid = self._w(
            "INSERT INTO packages (name, price, prints_included, extra_print_price, max_prints, active, sort, created_at) VALUES (?,?,?,?,?,?,?,?)",
            (data["name"], data["price"], data["prints_included"], data["extra_print_price"], data["max_prints"], int(data.get("active", True)), sort, now()),
        )
        return self.package(pid)

    def update_package(self, package_id: int, data: dict) -> dict | None:
        sets = {k: (int(v) if k == "active" else v) for k, v in data.items() if k in PACKAGE_FIELDS and v is not None}
        if sets:
            self._w(f"UPDATE packages SET {', '.join(f'{k} = ?' for k in sets)} WHERE id = ?", (*sets.values(), package_id))
        return self.package(package_id)

    def delete_package(self, package_id: int) -> bool:
        return bool(self._w("DELETE FROM packages WHERE id = ?", (package_id,)))
