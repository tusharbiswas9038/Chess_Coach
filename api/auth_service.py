import base64
import hashlib
import hmac
import json
import logging
import secrets
import time
from typing import Any

import config


log = logging.getLogger("chess_coach.auth")

PBKDF2_ALGORITHM = "pbkdf2_sha256"


def auth_required() -> bool:
    return bool(config.ADMIN_TOKEN or config.ADMIN_PASSWORD_HASH or config.is_production())


def password_hash_configured() -> bool:
    return bool(config.ADMIN_PASSWORD_HASH)


def admin_token_fallback_active() -> bool:
    """
    True when login will accept the admin token in place of a password.
    This fallback is only meant for the transition period before
    `ADMIN_PASSWORD_HASH` is set; production refuses to start without it.
    """
    return bool(config.ADMIN_TOKEN and not config.ADMIN_PASSWORD_HASH)


def _b64_encode(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).decode("ascii").rstrip("=")


def _b64_decode(value: str) -> bytes:
    padding = "=" * (-len(value) % 4)
    return base64.urlsafe_b64decode(value + padding)


def create_password_hash(password: str, *, iterations: int = 260000) -> str:
    salt = secrets.token_bytes(16)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, iterations)
    return f"{PBKDF2_ALGORITHM}${iterations}${_b64_encode(salt)}${_b64_encode(digest)}"


def verify_password(password: str, password_hash: str) -> bool:
    try:
        algorithm, iterations_raw, salt_raw, digest_raw = password_hash.split("$", 3)
        if algorithm != PBKDF2_ALGORITHM:
            return False
        iterations = int(iterations_raw)
        salt = _b64_decode(salt_raw)
        expected = _b64_decode(digest_raw)
        actual = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, iterations)
        return hmac.compare_digest(actual, expected)
    except Exception:
        return False


def verify_admin_login(username: str, password: str) -> bool:
    if not hmac.compare_digest(username, config.ADMIN_USERNAME):
        return False
    if config.ADMIN_PASSWORD_HASH:
        return verify_password(password, config.ADMIN_PASSWORD_HASH)
    if config.ADMIN_TOKEN and not config.is_production():
        # Transitional fallback: only honored outside production. Production
        # startup validation refuses to boot without ADMIN_PASSWORD_HASH.
        ok = hmac.compare_digest(password, config.ADMIN_TOKEN)
        if ok:
            log.warning(
                "admin_login_fallback_used: ADMIN_TOKEN accepted as password — "
                "set ADMIN_PASSWORD_HASH and remove this fallback."
            )
        return ok
    return False


def _sign(value: str) -> str:
    digest = hmac.new(
        config.APP_SECRET_KEY.encode("utf-8"),
        value.encode("utf-8"),
        hashlib.sha256,
    ).digest()
    return _b64_encode(digest)


def create_session_token(username: str) -> str:
    now = int(time.time())
    payload = {
        "sub": username,
        "iat": now,
        "exp": now + config.SESSION_TTL_SECONDS,
        "nonce": secrets.token_urlsafe(18),
    }
    body = _b64_encode(json.dumps(payload, separators=(",", ":")).encode("utf-8"))
    return f"{body}.{_sign(body)}"


def validate_session_token(token: str | None) -> dict[str, Any] | None:
    if not token or "." not in token:
        return None
    body, signature = token.rsplit(".", 1)
    if not hmac.compare_digest(signature, _sign(body)):
        return None
    try:
        payload = json.loads(_b64_decode(body))
    except Exception:
        return None
    if payload.get("sub") != config.ADMIN_USERNAME:
        return None
    if int(payload.get("exp", 0)) < int(time.time()):
        return None
    return payload
