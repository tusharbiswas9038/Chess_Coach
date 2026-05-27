from typing import Any, Dict, List

from fastapi import APIRouter, Depends, Request

from api.dependencies import get_game_repo
from api.repositories.game_repository import GameRepository
from api.security import enforce_rate_limit
from api.services.cache_service import TTLCache, register_analytics_cache_clearer
from api.schemas.contracts import PlayerModelResponse, WeeklyFocusResponse

router = APIRouter(prefix="/api/product", tags=["product"])

_CACHE = TTLCache(ttl_seconds=60)


def clear_product_cache() -> None:
    _CACHE.clear()

register_analytics_cache_clearer(clear_product_cache)


def _build_actions(primary: Dict[str, Any] | None, secondary: Dict[str, Any] | None, due_drills: int) -> List[str]:
    actions: List[str] = []
    if due_drills > 0:
        actions.append(f"Clear {min(due_drills, 20)} due drills before adding new games.")
    if primary:
        ptype = primary["type"].replace("_", " ")
        phase = primary.get("phase") or "all phases"
        actions.append(f"Review 3 recent {ptype} mistakes in {phase} and write one correction rule.")
        actions.append(f"Play next 3 games with a {ptype} blunder-check on every move.")
    if secondary:
        stype = secondary["type"].replace("_", " ")
        actions.append(f"Add one focused drill block for {stype} mistakes this week.")
    if not actions:
        actions.append("No major leak detected. Focus on opening prep and consistency drills.")
    return actions


def build_weekly_focus_payload(repo: GameRepository) -> Dict[str, Any]:
    snapshot = repo.get_weekly_focus_snapshot()
    grouped = snapshot["recent_mistakes"]
    primary = grouped[0] if grouped else None
    secondary = grouped[1] if len(grouped) > 1 else None

    recent_total = snapshot["recent_mistakes_total"]
    prior_total = snapshot["prior_mistakes_total"]
    trend = "flat"
    if prior_total > 0:
        ratio = (recent_total - prior_total) / prior_total
        if ratio > 0.15:
            trend = "worsening"
        elif ratio < -0.15:
            trend = "improving"
    elif recent_total > 0:
        trend = "worsening"

    return {
        "window_days": 14,
        "primary_focus": primary,
        "secondary_focus": secondary,
        "due_drills": snapshot["due_drills"],
        "recent_games_total": snapshot["recent_games_total"],
        "recent_games_analyzed": snapshot["recent_games_analyzed"],
        "mistake_trend": trend,
        "actions": _build_actions(primary, secondary, snapshot["due_drills"]),
    }


@router.get("/weekly-focus", response_model=WeeklyFocusResponse)
def weekly_focus(request: Request, repo: GameRepository = Depends(get_game_repo)):
    enforce_rate_limit(request, bucket="product-weekly-focus", limit=60, window_sec=60)
    cached = _CACHE.get("weekly_focus")
    if cached is not None:
        return cached

    payload = build_weekly_focus_payload(repo)
    _CACHE.set("weekly_focus", payload)
    return payload


@router.get("/player-model/latest", response_model=PlayerModelResponse)
def latest_player_model(request: Request):
    enforce_rate_limit(request, bucket="product-player-model", limit=60, window_sec=60)
    from api.services.player_model import get_latest_player_model_snapshot

    cached = _CACHE.get("player_model_latest")
    if cached is not None:
        return cached

    snapshot = get_latest_player_model_snapshot()
    payload = snapshot or {"status": "empty", "message": "No player model snapshot computed yet."}
    _CACHE.set("player_model_latest", payload)
    return payload


@router.get("/insights/latest")
def latest_insights(request: Request):
    enforce_rate_limit(request, bucket="product-insights", limit=60, window_sec=60)
    from api.services.analytics import compute_and_store_analytics_snapshot, get_latest_analytics_snapshot

    cached = _CACHE.get("insights_latest")
    if cached is not None:
        return cached

    snapshot = get_latest_analytics_snapshot()
    if not snapshot:
        snapshot = compute_and_store_analytics_snapshot(source="on-demand")
    _CACHE.set("insights_latest", snapshot)
    return snapshot


@router.get("/motifs/latest")
def latest_motifs(request: Request, limit: int = 8):
    """Recent recurring-mistake clusters. Empty list when none yet computed."""
    enforce_rate_limit(request, bucket="product-motifs", limit=60, window_sec=60)
    from api.services.mistake_motifs import get_latest_motifs

    safe_limit = max(1, min(int(limit), 25))
    cache_key = f"motifs_latest_{safe_limit}"
    cached = _CACHE.get(cache_key)
    if cached is not None:
        return cached

    motifs = get_latest_motifs(limit=safe_limit)
    payload = {"motifs": motifs, "count": len(motifs)}
    _CACHE.set(cache_key, payload)
    return payload


@router.post("/motifs/clear-labels")
def clear_motif_labels_endpoint(request: Request):
    """
    Wipe all coach_label values so the next analyze/player-model job
    regenerates them. Useful when prompt style changes.
    """
    from api.security import require_admin_if_configured
    from api.services.mistake_motifs import clear_motif_labels

    require_admin_if_configured(request)
    enforce_rate_limit(request, bucket="product-motifs-clear", limit=10, window_sec=60)
    cleared = clear_motif_labels()
    _CACHE.clear()
    return {"status": "cleared", "rows": cleared}
