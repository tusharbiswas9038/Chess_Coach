import functools # New import
import time
from typing import Any, List, Dict
from fastapi import APIRouter, Depends, HTTPException

from api.repositories.game_repository import GameRepository
from api.dependencies import get_game_repo, DRILLS_OK # New Import
from api.routers.product import build_weekly_focus_payload

from api.db import get_db, db_conn

router = APIRouter(prefix="/api", tags=["stats"])
_TTL_CACHE: Dict[str, Dict[str, Any]] = {}
_TTL_SECONDS = 30


def _ttl_get(key: str):
    item = _TTL_CACHE.get(key)
    if not item:
        return None
    if (time.time() - item["ts"]) > _TTL_SECONDS:
        _TTL_CACHE.pop(key, None)
        return None
    return item["value"]


def _ttl_set(key: str, value: Any):
    _TTL_CACHE[key] = {"ts": time.time(), "value": value}

@functools.lru_cache(maxsize=1)
def _get_cached_stats(drills_ok: bool) -> Dict[str, Any]:
    """Helper function to fetch stats data with caching."""
    with db_conn() as conn:
        repo = GameRepository(conn)
        stats_data = repo.get_stats(drills_ok)
    
    # Perform calculations here that were previously in get_stats
    total = stats_data["totals"]["total"] or 1  # avoid division by zero
    analyzed = stats_data["totals"]["analyzed"] or 0

    return {
        "profile": stats_data["profile"] or {},
        "games": dict(stats_data["totals"]),
        "hanging_piece_rate": round(stats_data["hanging_games"] / analyzed, 4) if analyzed else 0,
        "blunders_per_game": round(stats_data["blunders"]["total_blunders"] / analyzed, 2) if analyzed else 0,
        "recent_games": stats_data["recent_games"],
        "mistake_breakdown": stats_data["mistake_breakdown"],
        "weekly_stats": stats_data["weekly_stats"],
        "drills_due": stats_data["drills_due"],
        "due_drills_warning": stats_data["drills_due"] > 10,
    }

def clear_stats_cache():
    """Manually clear the stats cache."""
    _get_cached_stats.cache_clear()
    _TTL_CACHE.clear()


@router.get("/stats")
def get_stats():
    return _get_cached_stats(DRILLS_OK)


@router.get("/dashboard/bootstrap")
def dashboard_bootstrap(repo: GameRepository = Depends(get_game_repo)):
    key = "dashboard_bootstrap"
    cached = _ttl_get(key)
    if cached is not None:
        return cached

    stats = _get_cached_stats(DRILLS_OK)
    weekly_focus = build_weekly_focus_payload(repo)
    sessions = repo.get_sessions(1)

    payload = {
        "stats": stats,
        "weekly_focus": weekly_focus,
        "latest_session": sessions[0] if sessions else None,
    }
    _ttl_set(key, payload)
    return payload

@router.post("/stats/clear_cache")
def clear_stats_cache_endpoint():
    clear_stats_cache()
    return {"status": "Stats cache cleared"}


@router.get("/analysis/progress")
def analysis_progress(repo: GameRepository = Depends(get_game_repo)):
    result = repo.get_analysis_progress()
    return dict(result)


@router.get("/mistakes/by-phase")
def mistakes_by_phase(phase: str | None = None, repo: GameRepository = Depends(get_game_repo)):
    rows = repo.get_mistakes_by_phase(phase=phase)
    return [dict(r) for r in rows]

@router.get("/mistakes/critical")
def critical_mistakes(limit: int = 20, phase: str | None = None, repo: GameRepository = Depends(get_game_repo)):
    limit = max(1, min(limit, 100))
    key = f"critical:{limit}:{phase or 'all'}"
    cached = _ttl_get(key)
    if cached is not None:
        return cached
    result = repo.get_critical_mistakes(limit, phase=phase)
    _ttl_set(key, result)
    return result

@router.get("/stats/blunder_heatmap")
def blunder_heatmap(phase: str | None = None, repo: GameRepository = Depends(get_game_repo)):
    """
    Returns a heatmap of squares where blunders (and hanging pieces) occurred.
    Maps square name (e.g., 'e4') to count.
    """
    key = f"blunder_heatmap:{phase or 'all'}"
    cached = _ttl_get(key)
    if cached is not None:
        return cached
    result = repo.get_blunder_heatmap_data(phase=phase)
    _ttl_set(key, result)
    return result

@router.get("/mistakes/weekly-motifs")
def weekly_motifs(limit: int = 3, phase: str | None = None, repo: GameRepository = Depends(get_game_repo)):
    key = f"weekly_motifs:{limit}:{phase or 'all'}"
    cached = _ttl_get(key)
    if cached is not None:
        return cached
    result = repo.get_weekly_error_motifs(limit=limit, phase=phase)
    _ttl_set(key, result)
    return result
