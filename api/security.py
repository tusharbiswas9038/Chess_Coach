import threading
import time
from collections import defaultdict, deque
from typing import Deque, Dict

from fastapi import HTTPException, Request
import config


_rate_lock = threading.Lock()
_rate_buckets: Dict[str, Deque[float]] = defaultdict(deque)


def _rate_key(bucket: str, request: Request) -> str:
    client_ip = request.client.host if request.client else "unknown"
    return f"{bucket}:{client_ip}"


def enforce_rate_limit(request: Request, *, bucket: str, limit: int, window_sec: int) -> None:
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


def require_admin_if_configured(request: Request) -> None:
    # Self-hosted friendly: only enforced when ADMIN_TOKEN is explicitly set.
    if not config.ADMIN_TOKEN:
        return
    presented = request.headers.get("X-ADMIN-TOKEN", "")
    if presented != config.ADMIN_TOKEN:
        raise HTTPException(status_code=403, detail="Admin token required.")
