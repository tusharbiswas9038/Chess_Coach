from typing import Any, List, Dict
from fastapi import APIRouter, HTTPException, Depends

from api.repositories.game_repository import GameRepository
from api.dependencies import get_game_repo # New: import from dependencies

router = APIRouter(prefix="/api/openings", tags=["openings"])


@router.get("/summary")
def openings_summary(limit: int = 300, repo: GameRepository = Depends(get_game_repo)):
    """
    Pre-aggregated opening performance summary by ECO + color.
    Used by frontend openings view to avoid client-side full-game aggregation.
    """
    rows = repo.get_openings_summary(limit=limit)
    return rows


@router.get("/genome")
def opening_genome(eco: str, color: str, repo: GameRepository = Depends(get_game_repo)):
    """
    For a given ECO code, show win rate at each move depth.
    Tells you exactly where in the opening you start losing ground.
    """
    color = color.lower().strip()
    if color not in {"white", "black"}:
        raise HTTPException(400, "Invalid color; expected 'white' or 'black'")

    data = repo.get_opening_genome_data(eco, color)
    total_games = data["total_games"]
    ply_rows = data["ply_rows"]

    if not total_games:
        raise HTTPException(404, "No games found for this opening")

    return {
        "eco": eco,
        "color": color,
        "total_games": total_games,
        "winrate_by_ply": {
            str(r["ply"]): {
                "total": r["total"],
                "wins": r["wins"] or 0,
                "win_pct": round((r["wins"] or 0) / r["total"] * 100, 1) if r["total"] else 0,
            }
            for r in ply_rows
        }
    }
