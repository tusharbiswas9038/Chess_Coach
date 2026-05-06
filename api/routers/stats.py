from typing import Any, List, Dict
from fastapi import APIRouter, Depends, HTTPException

from api.repositories.game_repository import GameRepository
from api.main import get_game_repo
from api.main import _DRILLS_OK # Import global variable, consider refactoring later


router = APIRouter(tags=["stats"])


@router.get("/api/stats")
def get_stats(repo: GameRepository = Depends(get_game_repo)):
    stats_data = repo.get_stats(_DRILLS_OK)

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
    }


@router.get("/api/analysis/progress")
def analysis_progress(repo: GameRepository = Depends(get_game_repo)):
    result = repo.get_analysis_progress()
    return dict(result)


@router.get("/api/mistakes/by-phase")
def mistakes_by_phase(repo: GameRepository = Depends(get_game_repo)):
    rows = repo.get_mistakes_by_phase()
    return [dict(r) for r in rows]
