"""Superadmin login: one account, scrypt password hash from the environment, signed cookie.

The cookie carries only an expiry and an HMAC; nothing is stored server side. The signature
also covers a fingerprint of the password hash, so setting a new password logs every
browser out.
"""

import base64
import hashlib
import hmac
import os
import secrets
import time
from pathlib import Path

from fastapi import HTTPException, Request

COOKIE = "pb_admin"
# Mutating admin requests must send this header. Browsers only let same-origin scripts set
# custom headers (anything cross-site needs a CORS preflight we never answer), so together
# with SameSite=Strict it stops CSRF without a token dance.
CSRF_HEADER = "x-requested-with"
CSRF_VALUE = "jepret"

_N, _R, _P = 2**14, 8, 1


def _b64(b: bytes) -> str:
    return base64.urlsafe_b64encode(b).rstrip(b"=").decode()


def _unb64(s: str) -> bytes:
    return base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))


def hash_password(password: str) -> str:
    """`scrypt:N:r:p:salt:hash` — no `$`, so it survives systemd EnvironmentFile parsing."""
    salt = secrets.token_bytes(16)
    dk = hashlib.scrypt(password.encode(), salt=salt, n=_N, r=_R, p=_P, dklen=32)
    return f"scrypt:{_N}:{_R}:{_P}:{_b64(salt)}:{_b64(dk)}"


def verify_password(password: str, stored: str) -> bool:
    try:
        algo, n, r, p, salt, expected = stored.split(":")
        if algo != "scrypt":
            return False
        dk = hashlib.scrypt(password.encode(), salt=_unb64(salt), n=int(n), r=int(r), p=int(p), dklen=32)
    except (ValueError, TypeError):
        return False
    return hmac.compare_digest(dk, _unb64(expected))


def load_secret(path: Path) -> bytes:
    """Per-install signing key, created on first start and kept next to the database."""
    try:
        return path.read_bytes()
    except FileNotFoundError:
        path.parent.mkdir(parents=True, exist_ok=True)
        key = secrets.token_bytes(32)
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, "wb") as f:
            f.write(key)
        return key


class Auth:
    def __init__(self, secret: bytes, user: str, password_hash: str, days: int):
        self.secret = secret
        self.user = user
        self.password_hash = password_hash
        self.ttl = days * 86400

    @property
    def configured(self) -> bool:
        return bool(self.password_hash)

    def _sign(self, exp: int) -> str:
        msg = f"{exp}.{self.user}.{self.password_hash[-12:]}".encode()
        return _b64(hmac.new(self.secret, msg, hashlib.sha256).digest())

    def check_login(self, user: str, password: str) -> bool:
        if not self.configured:
            return False
        # Evaluate both so a wrong username costs the same time as a wrong password.
        ok_user = hmac.compare_digest(user.strip().lower().encode(), self.user.lower().encode())
        ok_pass = verify_password(password, self.password_hash)
        return ok_user and ok_pass

    def issue(self) -> tuple[str, int]:
        exp = int(time.time()) + self.ttl
        return f"{exp}.{self._sign(exp)}", self.ttl

    def valid(self, token: str | None) -> bool:
        if not token or not self.configured:
            return False
        exp, _, sig = token.partition(".")
        if not exp.isdigit() or int(exp) < time.time():
            return False
        return hmac.compare_digest(sig, self._sign(int(exp)))


def require_admin(request: Request) -> None:
    auth: Auth = request.app.state.auth
    if not auth.valid(request.cookies.get(COOKIE)):
        raise HTTPException(401, "Silakan masuk dulu")
    if request.method not in ("GET", "HEAD") and request.headers.get(CSRF_HEADER) != CSRF_VALUE:
        raise HTTPException(403, "Permintaan ditolak")


def is_admin(request: Request) -> bool:
    return request.app.state.auth.valid(request.cookies.get(COOKIE))
