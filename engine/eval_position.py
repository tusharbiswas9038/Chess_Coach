"""
Interactive position evaluation. Used by the review-board what-if feature
to score a hypothetical move without polluting the persisted analysis.

Stockfish runs as a module-level singleton — popen costs ~1.5s on first call,
so reusing the same engine across what-if requests cuts perceived latency
dramatically. A lock serializes access (the interactive endpoint is rate-
limited to 20/min, so contention is low). If the engine dies, the next call
respawns transparently.
"""
from __future__ import annotations

import atexit
import logging
import threading
from collections import OrderedDict
from typing import Any, Dict, Optional

import chess
import chess.engine

from config import STOCKFISH_PATH, STOCKFISH_HASH_MB, STOCKFISH_THREADS

log = logging.getLogger("chess_coach.engine.eval_position")

# Depth bounds and default. Quick=10, Standard=14, Deep=18 expose a small
# tradeoff curve to the UI without letting users push the engine into
# pathological territory.
MIN_WHATIF_DEPTH = 8
DEFAULT_WHATIF_DEPTH = 14
MAX_WHATIF_DEPTH = 22
WHATIF_TIMEOUT_SEC = 8.0

# LRU cache: same (fen, uci, depth) often gets re-asked when the user is
# exploring a position. 256 entries is generous given a typical session
# explores a few dozen positions.
WHATIF_CACHE_MAX = 256

_engine_lock = threading.Lock()
_engine: Optional[chess.engine.SimpleEngine] = None
_cache_lock = threading.Lock()
_cache: "OrderedDict[tuple, Dict[str, Any]]" = OrderedDict()


def clamp_depth(value: Any) -> int:
    try:
        depth = int(value)
    except (TypeError, ValueError):
        return DEFAULT_WHATIF_DEPTH
    return max(MIN_WHATIF_DEPTH, min(MAX_WHATIF_DEPTH, depth))


def _spawn_engine() -> chess.engine.SimpleEngine:
    engine = chess.engine.SimpleEngine.popen_uci(STOCKFISH_PATH)
    try:
        engine.configure({"Threads": STOCKFISH_THREADS, "Hash": STOCKFISH_HASH_MB})
    except chess.engine.EngineError:
        # Older Stockfish builds may reject unknown options — keep going.
        pass
    log.info("whatif engine started pid=%s", getattr(engine.transport, "_proc", None))
    return engine


def _ensure_engine() -> chess.engine.SimpleEngine:
    """Return the singleton engine, lazily spawning or respawning as needed."""
    global _engine
    if _engine is None:
        _engine = _spawn_engine()
    return _engine


def _shutdown_engine() -> None:
    global _engine
    with _engine_lock:
        if _engine is not None:
            try:
                _engine.quit()
            except Exception:
                pass
            _engine = None


atexit.register(_shutdown_engine)


def _normalize_eval(score: chess.engine.Score, turn: chess.Color) -> int:
    if score.is_mate():
        return 10000 if score.mate() > 0 else -10000
    cp = score.score(mate_score=10000)
    return cp if turn == chess.WHITE else -cp


def _analyse_with_retry(board: chess.Board, depth: int) -> Dict[str, Any]:
    """Run analyse() against the singleton engine; respawn once on death."""
    global _engine
    limit = chess.engine.Limit(depth=depth, time=WHATIF_TIMEOUT_SEC)
    engine = _ensure_engine()
    try:
        return engine.analyse(board, limit)
    except chess.engine.EngineTerminatedError:
        log.warning("whatif engine terminated; respawning")
        _engine = None
        engine = _ensure_engine()
        return engine.analyse(board, limit)


def evaluate_what_if(
    fen: str,
    uci: str,
    depth: int = DEFAULT_WHATIF_DEPTH,
    *,
    bypass_cache: bool = False,
) -> Dict[str, Any]:
    """
    Score a hypothetical move from the given FEN.

    Returns:
        {
          "ok": bool,
          "eval_before": int|None,    # cp from side-to-move-before perspective
          "eval_after": int|None,     # cp from same perspective
          "delta": int|None,          # eval_after - eval_before
          "best_move": str|None,      # UCI of Stockfish's preferred move
          "depth": int,
          "cached": bool,             # true if served from LRU
          "error": str|None,
        }
    Bad input (illegal move, malformed FEN) returns ok=False with a message
    rather than raising, since the route handler is interactive-only.
    """
    try:
        board = chess.Board(fen)
    except Exception as exc:
        return _err(f"Invalid FEN: {exc}")
    if not board.is_valid():
        return _err("Position is not legal")

    try:
        move = chess.Move.from_uci(uci)
    except Exception as exc:
        return _err(f"Invalid move format: {exc}")
    if move not in board.legal_moves:
        return _err("Move is not legal in this position")

    safe_depth = clamp_depth(depth)
    cache_key = (fen, uci.lower(), safe_depth)

    if not bypass_cache:
        cached = _cache_get(cache_key)
        if cached is not None:
            return {**cached, "cached": True}

    turn_before = board.turn

    with _engine_lock:
        try:
            info_before = _analyse_with_retry(board, safe_depth)
            eval_before = _normalize_eval(info_before["score"].relative, turn_before)
            best_move_obj = info_before.get("pv", [None])[0]
            best_move = best_move_obj.uci() if best_move_obj else None

            board.push(move)
            info_after = _analyse_with_retry(board, safe_depth)
            # info_after["score"].relative is from the *new* side-to-move's
            # perspective, so we negate to express it from the original mover's.
            eval_after = -_normalize_eval(info_after["score"].relative, not turn_before)

            payload = {
                "ok": True,
                "eval_before": int(eval_before),
                "eval_after": int(eval_after),
                "delta": int(eval_after - eval_before),
                "best_move": best_move,
                "depth": safe_depth,
                "cached": False,
                "error": None,
            }
            _cache_put(cache_key, payload)
            return payload
        except Exception as exc:
            log.warning("whatif eval failed: %s", exc)
            return _err(str(exc)[:200])


def _cache_get(key: tuple) -> Optional[Dict[str, Any]]:
    with _cache_lock:
        if key in _cache:
            _cache.move_to_end(key)
            return dict(_cache[key])
    return None


def _cache_put(key: tuple, value: Dict[str, Any]) -> None:
    # Cache only successful results; we don't want a transient failure to
    # be remembered.
    if not value.get("ok"):
        return
    with _cache_lock:
        _cache[key] = dict(value)
        _cache.move_to_end(key)
        while len(_cache) > WHATIF_CACHE_MAX:
            _cache.popitem(last=False)


def clear_cache() -> int:
    with _cache_lock:
        n = len(_cache)
        _cache.clear()
    return n


def cache_size() -> int:
    with _cache_lock:
        return len(_cache)


def _err(msg: str) -> Dict[str, Any]:
    return {
        "ok": False,
        "eval_before": None,
        "eval_after": None,
        "delta": None,
        "best_move": None,
        "depth": None,
        "cached": False,
        "error": msg,
    }
