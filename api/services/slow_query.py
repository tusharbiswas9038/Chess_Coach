"""
Lightweight slow-query instrumentation.

Wraps a labeled span (query name + optional context) around a database call,
emits a single log line if it exceeds the threshold, and updates an in-process
counter. The counter is read by /api/metrics so we can see drift without
attaching a debugger.

Kept dependency-free on purpose — this should never break a request handler.
"""
from __future__ import annotations

import logging
import os
import threading
import time
from collections import defaultdict
from contextlib import contextmanager
from functools import wraps
from typing import Any, Callable, Dict

log = logging.getLogger("chess_coach.db.slow_query")

# Threshold in seconds. 250ms is tight enough to catch real regressions
# (e.g. the 770ms heatmap that prompted this instrumentation) but well
# above the slowest current hot-path call (~60ms on 70k moves), so it
# won't fire under normal load. Override with env for one-off debugging.
SLOW_QUERY_THRESHOLD_SEC = float(os.getenv("SLOW_QUERY_THRESHOLD_SEC", "0.25"))

# How many recent slow queries to keep, per name. Used by /api/metrics for a
# bounded "what was slow recently" view.
RECENT_KEEP = 20


_lock = threading.Lock()
_call_count: Dict[str, int] = defaultdict(int)
_slow_count: Dict[str, int] = defaultdict(int)
_recent_slow: list[dict[str, Any]] = []


@contextmanager
def slow_query_span(name: str, **context: Any):
    """Context manager: time a block of DB work and emit if it crosses the threshold."""
    start = time.perf_counter()
    try:
        yield
    finally:
        elapsed = time.perf_counter() - start
        with _lock:
            _call_count[name] += 1
            if elapsed >= SLOW_QUERY_THRESHOLD_SEC:
                _slow_count[name] += 1
                entry = {
                    "name": name,
                    "elapsed_ms": round(elapsed * 1000, 1),
                    "context": context or None,
                    "ts": time.time(),
                }
                _recent_slow.append(entry)
                if len(_recent_slow) > RECENT_KEEP:
                    del _recent_slow[: len(_recent_slow) - RECENT_KEEP]
                log.warning(
                    "slow_query name=%s elapsed_ms=%.1f context=%s",
                    name,
                    elapsed * 1000,
                    context or {},
                )


def track_slow_queries(name: str) -> Callable:
    """
    Decorator form. Wraps a method/function in a slow_query_span. Reads
    common context off kwargs (limit, phase, color) for log richness without
    being load-bearing.
    """
    def decorator(fn: Callable) -> Callable:
        @wraps(fn)
        def wrapper(*args, **kwargs):
            ctx: Dict[str, Any] = {}
            for k in ("limit", "phase", "color", "eco"):
                if k in kwargs and kwargs[k] is not None:
                    ctx[k] = kwargs[k]
            with slow_query_span(name, **ctx):
                return fn(*args, **kwargs)
        return wrapper
    return decorator


def get_slow_query_metrics() -> Dict[str, Any]:
    """Snapshot for /api/metrics consumption. Cheap; safe to call often."""
    with _lock:
        return {
            "threshold_ms": int(SLOW_QUERY_THRESHOLD_SEC * 1000),
            "calls": dict(_call_count),
            "slow_calls": dict(_slow_count),
            "recent_slow": list(_recent_slow[-10:]),  # only last 10 for compactness
        }


def reset_slow_query_metrics() -> None:
    """Test helper. Not exposed via the API."""
    with _lock:
        _call_count.clear()
        _slow_count.clear()
        _recent_slow.clear()
