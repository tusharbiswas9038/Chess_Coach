import time
from typing import Any, Dict, List

from fastapi import APIRouter, Depends, Request

from api.dependencies import get_game_repo
from api.repositories.game_repository import GameRepository
from api.security import enforce_rate_limit

router = APIRouter(prefix="/api/product", tags=["product"])

_CACHE: Dict[str, Dict[str, Any]] = {}
_TTL_SECONDS = 60


def clear_product_cache() -> None:
    _CACHE.clear()


def _cache_get(key: str):
    item = _CACHE.get(key)
    if not item:
        return None
    if (time.time() - item["ts"]) > _TTL_SECONDS:
        _CACHE.pop(key, None)
        return None
    return item["value"]


def _cache_set(key: str, value: Any):
    _CACHE[key] = {"ts": time.time(), "value": value}


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


@router.get("/weekly-focus")
def weekly_focus(request: Request, repo: GameRepository = Depends(get_game_repo)):
    enforce_rate_limit(request, bucket="product-weekly-focus", limit=60, window_sec=60)
    cached = _cache_get("weekly_focus")
    if cached is not None:
        return cached

    payload = build_weekly_focus_payload(repo)
    _cache_set("weekly_focus", payload)
    return payload


@router.get("/player-model/latest")
def latest_player_model(request: Request):
    enforce_rate_limit(request, bucket="product-player-model", limit=60, window_sec=60)
    from api.services.player_model import get_latest_player_model_snapshot

    cached = _cache_get("player_model_latest")
    if cached is not None:
        return cached

    snapshot = get_latest_player_model_snapshot()
    payload = snapshot or {"status": "empty", "message": "No player model snapshot computed yet."}
    _cache_set("player_model_latest", payload)
    return payload
