import threading
import time
import hmac
from collections import defaultdict, deque
from typing import Deque, Dict
import sqlite3

from fastapi import HTTPException, Request
import config


_rate_lock = threading.Lock()
_rate_buckets: Dict[str, Deque[float]] = defaultdict(deque)
_sqlite_init_lock = threading.Lock()
_sqlite_initialized = False


def _ensure_sqlite_rate_limit_table() -> None:
    global _sqlite_initialized
    if _sqlite_initialized:
        return
    with _sqlite_init_lock:
        if _sqlite_initialized:
            return
        conn = sqlite3.connect(str(config.DB_PATH), timeout=30)
        try:
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS rate_limit_events (
                    key TEXT NOT NULL,
                    ts REAL NOT NULL
                )
                """
            )
            conn.execute(
                "CREATE INDEX IF NOT EXISTS idx_rate_limit_events_key_ts ON rate_limit_events(key, ts)"
            )
            conn.commit()
            _sqlite_initialized = True
        finally:
            conn.close()


def _rate_key(bucket: str, request: Request) -> str:
    client_ip = request.client.host if request.client else "unknown"
    return f"{bucket}:{client_ip}"


def enforce_rate_limit(request: Request, *, bucket: str, limit: int, window_sec: int) -> None:
    if config.RATE_LIMIT_BACKEND == "sqlite":
        enforce_rate_limit_sqlite(
            request, bucket=bucket, limit=limit, window_sec=window_sec
        )
        return
    enforce_rate_limit_memory(request, bucket=bucket, limit=limit, window_sec=window_sec)


def enforce_rate_limit_memory(request: Request, *, bucket: str, limit: int, window_sec: int) -> None:
    now = time.time()
    key = _rate_key(bucket, request)
    with _rate_lock:
        q = _rate_buckets[key]
        cutoff = now - window_sec
        while q and q[0] < cutoff:
            q.popleft()
        if len(q) >= limit:
            raise HTTPException(
                status_code=429,
                detail=f"Rate limit exceeded for {bucket}. Try again later.",
            )
        q.append(now)


def enforce_rate_limit_sqlite(request: Request, *, bucket: str, limit: int, window_sec: int) -> None:
    _ensure_sqlite_rate_limit_table()
    now = time.time()
    cutoff = now - window_sec
    key = _rate_key(bucket, request)

    conn = sqlite3.connect(str(config.DB_PATH), timeout=30)
    try:
        conn.execute("PRAGMA busy_timeout = 5000")
        conn.execute("BEGIN IMMEDIATE")
        conn.execute("DELETE FROM rate_limit_events WHERE ts < ?", (cutoff,))
        current_count = conn.execute(
            "SELECT COUNT(*) FROM rate_limit_events WHERE key = ? AND ts >= ?",
            (key, cutoff),
        ).fetchone()[0]
        if current_count >= limit:
            conn.rollback()
            raise HTTPException(
                status_code=429,
                detail=f"Rate limit exceeded for {bucket}. Try again later.",
            )
        conn.execute(
            "INSERT INTO rate_limit_events (key, ts) VALUES (?, ?)",
            (key, now),
        )
        conn.commit()
    finally:
        conn.close()


def get_rate_limit_status(*, key_prefix: str | None = None, limit: int = 100) -> dict:
    """
    Returns current rate-limit event counts from SQLite backend.
    When backend is memory, returns mode and empty details.
    """
    if config.RATE_LIMIT_BACKEND != "sqlite":
        return {
            "backend": config.RATE_LIMIT_BACKEND,
            "rows": [],
            "total_rows": 0,
            "note": "SQLite rate-limit table is not active for current backend.",
        }

    _ensure_sqlite_rate_limit_table()
    conn = sqlite3.connect(str(config.DB_PATH), timeout=30)
    conn.row_factory = sqlite3.Row
    try:
        safe_limit = max(1, min(int(limit), 500))
        if key_prefix:
            rows = conn.execute(
                """
                SELECT key, COUNT(*) AS cnt, MAX(ts) AS latest_ts
                FROM rate_limit_events
                WHERE key LIKE ?
                GROUP BY key
                ORDER BY cnt DESC, latest_ts DESC
                LIMIT ?
                """,
                (f"{key_prefix}%", safe_limit),
            ).fetchall()
        else:
            rows = conn.execute(
                """
                SELECT key, COUNT(*) AS cnt, MAX(ts) AS latest_ts
                FROM rate_limit_events
                GROUP BY key
                ORDER BY cnt DESC, latest_ts DESC
                LIMIT ?
                """,
                (safe_limit,),
            ).fetchall()

        total_rows = conn.execute("SELECT COUNT(*) FROM rate_limit_events").fetchone()[0]
        return {
            "backend": config.RATE_LIMIT_BACKEND,
            "rows": [dict(r) for r in rows],
            "total_rows": int(total_rows),
        }
    finally:
        conn.close()


def clear_rate_limit_events(*, key_prefix: str | None = None) -> dict:
    """
    Clears rate-limit events.
    - SQLite backend: delete rows from rate_limit_events.
    - Memory backend: clear in-memory buckets.
    """
    if config.RATE_LIMIT_BACKEND != "sqlite":
        with _rate_lock:
            before = sum(len(v) for v in _rate_buckets.values())
            _rate_buckets.clear()
        return {
            "backend": config.RATE_LIMIT_BACKEND,
            "deleted": int(before),
            "scope": "memory_all",
        }

    _ensure_sqlite_rate_limit_table()
    conn = sqlite3.connect(str(config.DB_PATH), timeout=30)
    try:
        conn.execute("BEGIN IMMEDIATE")
        if key_prefix:
            before = conn.execute(
                "SELECT COUNT(*) FROM rate_limit_events WHERE key LIKE ?",
                (f"{key_prefix}%",),
            ).fetchone()[0]
            conn.execute(
                "DELETE FROM rate_limit_events WHERE key LIKE ?",
                (f"{key_prefix}%",),
            )
            scope = f"sqlite_prefix:{key_prefix}"
        else:
            before = conn.execute("SELECT COUNT(*) FROM rate_limit_events").fetchone()[0]
            conn.execute("DELETE FROM rate_limit_events")
            scope = "sqlite_all"
        conn.commit()
        return {
            "backend": config.RATE_LIMIT_BACKEND,
            "deleted": int(before),
            "scope": scope,
        }
    finally:
        conn.close()


def require_admin_if_configured(request: Request) -> None:
    # Self-hosted friendly: only enforced when ADMIN_TOKEN is explicitly set.
    if not config.ADMIN_TOKEN:
        return
    presented = request.headers.get("X-ADMIN-TOKEN", "")
    if not hmac.compare_digest(presented, config.ADMIN_TOKEN):
        raise HTTPException(status_code=403, detail="Admin token required.")
