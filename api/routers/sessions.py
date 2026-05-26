from fastapi import APIRouter, Depends, HTTPException

from api.repositories.game_repository import GameRepository
from api.dependencies import get_game_repo, require_admin, rate_limit
from api.schemas.contracts import SessionDayResponse, StatusResponse
from api.services.job_enqueue_helpers import _enqueue_sessions_compute # Import helper
from api.job_queue import job_queue


router = APIRouter(tags=["sessions"])


@router.get("", response_model=list[dict])
def get_sessions(limit: int = 30, repo: GameRepository = Depends(get_game_repo)):
    limit = max(1, min(limit, 365))
    return repo.get_sessions(limit)


@router.get("/today", response_model=SessionDayResponse)
def get_today_session(repo: GameRepository = Depends(get_game_repo)):
    """Returns today's session — used for tilt warning on dashboard."""
    result = repo.get_today_session()
    return result if result else {"games_played": 0, "tilt_detected": 0, "result_sequence": ""}


@router.post("/compute", response_model=StatusResponse)
def recompute_sessions(
    _admin: None = Depends(require_admin),
    _rl: None = Depends(rate_limit("jobs-write", 10, 60)),
):
    if job_queue.is_job_type_active("sessions"):
        raise HTTPException(429, "Sessions job already in progress or queued.")
    _enqueue_sessions_compute()
    return {"status": "computing"}
