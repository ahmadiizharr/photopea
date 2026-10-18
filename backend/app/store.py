"""Session metadata in SQLite. Image files live in media/<code>/."""

import secrets
import shutil
import sqlite3
import threading
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path

# No 0/O, 1/I/L: codes get read aloud and typed on phones.
ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ"
CODE_LEN = 6


def is_code(value: str) -> bool:
    return len(value) == CODE_LEN and all(c in ALPHABET for c in value)


@dataclass
class Session:
    code: str
    layout: str
    frame: str
    filter: str
    n_shots: int
    has_gif: bool
    created_at: datetime
    expires_at: datetime
    template: str | None = None  # uploaded frame id, when the strip used one
    package_id: int | None = None
    prints: int | None = None
    total: int | None = None


# Added after the first release; created on start-up when missing.
EXTRA_COLUMNS = {"template": "TEXT", "package_id": "INTEGER", "prints": "INTEGER", "total": "INTEGER"}


class SessionStore:
    def __init__(self, db_path: Path, media_dir: Path, retention: timedelta):
        self.media_dir = media_dir
        self.retention = retention
        self._lock = threading.Lock()
        db_path.parent.mkdir(parents=True, exist_ok=True)
        media_dir.mkdir(parents=True, exist_ok=True)
        self._db = sqlite3.connect(db_path, check_same_thread=False)
        self._db.execute("PRAGMA journal_mode=WAL")
        self._db.execute(
            """CREATE TABLE IF NOT EXISTS sessions (
                code TEXT PRIMARY KEY,
                layout TEXT NOT NULL,
                frame TEXT NOT NULL,
                filter TEXT NOT NULL,
                n_shots INTEGER NOT NULL,
                has_gif INTEGER NOT NULL,
                created_at TEXT NOT NULL,
                expires_at TEXT NOT NULL
            )"""
        )
        self._db.execute("CREATE INDEX IF NOT EXISTS sessions_expires ON sessions(expires_at)")
        have = {r[1] for r in self._db.execute("PRAGMA table_info(sessions)")}
        for col, kind in EXTRA_COLUMNS.items():
            if col not in have:
                self._db.execute(f"ALTER TABLE sessions ADD COLUMN {col} {kind}")
        self._db.commit()

    def reserve_code(self) -> str:
        """Pick an unused code and create its media folder (the folder is the reservation)."""
        while True:
            code = "".join(secrets.choice(ALPHABET) for _ in range(CODE_LEN))
            folder = self.media_dir / code
            try:
                folder.mkdir()
            except FileExistsError:
                continue
            return code

    def release(self, code: str) -> None:
        shutil.rmtree(self.media_dir / code, ignore_errors=True)

    def add(
        self, code: str, layout: str, frame: str, filter_: str, n_shots: int, has_gif: bool,
        template: str | None = None, package_id: int | None = None, prints: int | None = None, total: int | None = None,
    ) -> Session:
        now = datetime.now(timezone.utc).replace(microsecond=0)
        s = Session(code, layout, frame, filter_, n_shots, has_gif, now, now + self.retention, template, package_id, prints, total)
        with self._lock:
            self._db.execute(
                """INSERT INTO sessions (code, layout, frame, filter, n_shots, has_gif, created_at, expires_at,
                   template, package_id, prints, total) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)""",
                (code, layout, frame, filter_, n_shots, int(has_gif), s.created_at.isoformat(), s.expires_at.isoformat(),
                 template, package_id, prints, total),
            )
            self._db.commit()
        return s

    def get(self, code: str) -> Session | None:
        if not is_code(code):
            return None
        with self._lock:
            row = self._db.execute(
                """SELECT code, layout, frame, filter, n_shots, has_gif, created_at, expires_at,
                   template, package_id, prints, total FROM sessions WHERE code = ?""",
                (code,),
            ).fetchone()
        if row is None:
            return None
        s = Session(
            code=row[0], layout=row[1], frame=row[2], filter=row[3], n_shots=row[4], has_gif=bool(row[5]),
            created_at=datetime.fromisoformat(row[6]), expires_at=datetime.fromisoformat(row[7]),
            template=row[8], package_id=row[9], prints=row[10], total=row[11],
        )
        if s.expires_at <= datetime.now(timezone.utc):
            return None
        return s

    def set_expiry(self, code: str, when: datetime) -> None:
        with self._lock:
            self._db.execute("UPDATE sessions SET expires_at = ? WHERE code = ?", (when.isoformat(), code))
            self._db.commit()

    def purge_expired(self) -> int:
        now = datetime.now(timezone.utc).isoformat()
        with self._lock:
            codes = [r[0] for r in self._db.execute("SELECT code FROM sessions WHERE expires_at <= ?", (now,))]
            self._db.execute("DELETE FROM sessions WHERE expires_at <= ?", (now,))
            self._db.commit()
        for code in codes:
            self.release(code)
        return len(codes)

    def close(self) -> None:
        self._db.close()
