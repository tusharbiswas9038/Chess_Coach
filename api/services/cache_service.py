import time
from threading import Lock
from typing import Any, Callable


class TTLCache:
    """Simple in-process TTL cache for lightweight API payload caching."""

    def __init__(self, ttl_seconds: int):
        self._ttl_seconds = max(1, int(ttl_seconds))
        self._data: dict[str, dict[str, Any]] = {}
        self._lock = Lock()

    def get(self, key: str) -> Any | None:
        now = time.time()
        with self._lock:
            item = self._data.get(key)
            if not item:
                return None
            if now - float(item["ts"]) > self._ttl_seconds:
                self._data.pop(key, None)
                return None
            return item["value"]

    def set(self, key: str, value: Any) -> None:
        with self._lock:
            self._data[key] = {"ts": time.time(), "value": value}

    def clear(self) -> None:
        with self._lock:
            self._data.clear()


_analytics_clearers: list[Callable[[], None]] = []
_analytics_lock = Lock()


def register_analytics_cache_clearer(fn: Callable[[], None]) -> None:
    with _analytics_lock:
        if fn not in _analytics_clearers:
            _analytics_clearers.append(fn)


def clear_analytics_caches() -> None:
    with _analytics_lock:
        clearers = list(_analytics_clearers)
    for fn in clearers:
        fn()
