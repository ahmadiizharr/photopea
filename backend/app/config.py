import os
from dataclasses import dataclass, field
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


@dataclass
class Settings:
    data_dir: Path = field(default_factory=lambda: Path(os.getenv("PHOTOBOX_DATA_DIR", ROOT / "data")))
    static_dir: Path = field(default_factory=lambda: Path(os.getenv("PHOTOBOX_STATIC_DIR", ROOT / "frontend" / "dist")))
    layouts_file: Path = field(default_factory=lambda: Path(os.getenv("PHOTOBOX_LAYOUTS", ROOT / "shared" / "layouts.json")))
    public_base_url: str = field(default_factory=lambda: os.getenv("PHOTOBOX_PUBLIC_URL", "http://localhost:8090"))
    brand: str = field(default_factory=lambda: os.getenv("PHOTOBOX_BRAND", "jepret"))
    retention_days: int = field(default_factory=lambda: int(os.getenv("PHOTOBOX_RETENTION_DAYS", "7")))
    # Superadmin login. The hash comes from `python -m app.cli set-admin` (written to an EnvironmentFile).
    admin_user: str = field(default_factory=lambda: os.getenv("PHOTOBOX_ADMIN_USER", "admin"))
    admin_hash: str = field(default_factory=lambda: os.getenv("PHOTOBOX_ADMIN_HASH", ""))
    admin_session_days: int = 14
    # Per file. A composed 1200x1500 JPEG is ~0.5 MB; 8 MB leaves room for PNG uploads.
    max_file_bytes: int = 8 * 1024 * 1024
    max_strip_px: tuple[int, int] = (4000, 6000)
    shot_long_side: int = 1600
    gif_width: int = 480
    # Frame PNGs from the dashboard: a 5R sheet with alpha is ~4-8 MB.
    max_frame_bytes: int = 20 * 1024 * 1024

    @property
    def media_dir(self) -> Path:
        return self.data_dir / "media"

    @property
    def db_path(self) -> Path:
        return self.data_dir / "photobox.db"

    @property
    def frames_dir(self) -> Path:
        return self.data_dir / "frames"

    @property
    def secret_path(self) -> Path:
        return self.data_dir / "secret.key"
