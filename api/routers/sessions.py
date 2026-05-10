from typing import Any
from fastapi import APIRouter, HTTPException, Depends

from api.repositories.game_repository import GameRepository
from api.dependencies import get_game_repo # New: import from dependencies
from api.services.job_enqueue_helpers import _enqueue_sessions_compute # Import helper


router = APIRouter(tags=["sessions"])


@router.get("")
def get_sessions(limit: int = 30, repo: GameRepository = Depends(get_game_repo)):
    limit = max(1, min(limit, 365))
    return repo.get_sessions(limit)


@router.get("/today")
def get_today_session(repo: GameRepository = Depends(get_game_repo)):
    """Returns today's session — used for tilt warning on dashboard."""
    result = repo.get_today_session()
    return result if result else {"games_played": 0, "tilt_detected": 0, "result_sequence": ""}


@router.post("/compute")
def recompute_sessions():
    _enqueue_sessions_compute()
    return {"status": "computing"}
