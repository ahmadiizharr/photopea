"""Admin tasks for the server.

    sudo .venv/bin/python -m app.cli set-admin            # tanya username + password, tulis /etc/photobox/admin.env
    sudo systemctl restart photobox

The env file is read by systemd (root) before the service drops to its throwaway user,
so it can stay 0600 root-only.
"""

import argparse
import getpass
import os
import sys
from pathlib import Path

from .auth import hash_password

DEFAULT_ENV = Path("/etc/photobox/admin.env")


def set_admin(env_file: Path, user: str | None) -> int:
    user = (user or input("Username [admin]: ").strip() or "admin").lower()
    if not user.isascii() or not user.replace("-", "").replace("_", "").replace(".", "").isalnum():
        print("Username hanya huruf, angka, titik, - dan _.", file=sys.stderr)
        return 1
    password = getpass.getpass("Password baru (min. 10 karakter): ")
    if len(password) < 10:
        print("Password terlalu pendek.", file=sys.stderr)
        return 1
    if getpass.getpass("Ulangi password: ") != password:
        print("Password tidak sama.", file=sys.stderr)
        return 1

    env_file.parent.mkdir(parents=True, exist_ok=True)
    tmp = env_file.with_suffix(".tmp")
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as f:
        f.write(f"PHOTOBOX_ADMIN_USER={user}\nPHOTOBOX_ADMIN_HASH={hash_password(password)}\n")
    tmp.replace(env_file)
    print(f"Tersimpan di {env_file}. Jalankan: systemctl restart photobox")
    return 0


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="python -m app.cli")
    sub = ap.add_subparsers(dest="cmd", required=True)
    sa = sub.add_parser("set-admin", help="atur username & password superadmin")
    sa.add_argument("--env-file", type=Path, default=DEFAULT_ENV)
    sa.add_argument("--user")
    args = ap.parse_args(argv)
    if args.cmd == "set-admin":
        return set_admin(args.env_file, args.user)
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
