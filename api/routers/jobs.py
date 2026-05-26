import logging
from typing import Callable
from fastapi import APIRouter, Depends, HTTPException

from api.jobs_service import enqueue_journals_job
from api.dependencies import COACH_OK, require_admin, rate_limit
from api.schemas.contracts import JobActionResponse, JobStatusResponse, StatusResponse
from api.services.job_enqueue_helpers import (
    _enqueue_sync,
    _enqueue_analysis,
    _enqueue_sessions_compute,
    _enqueue_player_model,
    _enqueue_weekly_report,
    _enqueue_db_maintenance,
)
from api.job_queue import job_queue


router = APIRouter(prefix="/api/jobs", tags=["jobs"])
log = logging.getLogger("chess_coach.api.jobs.router")


def _try_enqueue(enqueue_fn: Callable[[], None]) -> None:
    try:
        enqueue_fn()
    except RuntimeError as e:
        raise HTTPException(429, str(e))


@router.post("/sync", response_model=StatusResponse)
def job_sync(
    _admin: None = Depends(require_admin),
    _rl: None = Depends(rate_limit("jobs-write", 10, 60)),
):
    if job_queue.is_job_type_active("sync"):
        raise HTTPException(429, "Sync job already in progress or queued.")
    _try_enqueue(lambda: _enqueue_sync(full=False))
    return {"status": "sync started"}


@router.post("/analyze", response_model=StatusResponse)
def job_analyze(
    _admin: None = Depends(require_admin),
    _rl: None = Depends(rate_limit("jobs-write", 10, 60)),
):
    if job_queue.is_job_type_active("analyze"):
        raise HTTPException(429, "Analysis job already in progress or queued.")
    _try_enqueue(_enqueue_analysis)
    return {"status": "analysis started"}


@router.post("/journals", response_model=StatusResponse)
def job_journals(
    limit: int = 15,
    _admin: None = Depends(require_admin),
    _rl: None = Depends(rate_limit("jobs-write", 10, 60)),
):
    if not COACH_OK:
        raise HTTPException(501, "Coach not available")
    if job_queue.is_job_type_active("journals"):
        raise HTTPException(429, "Journals job already in progress or queued.")
    limit = max(1, min(limit, 50))
    _try_enqueue(lambda: enqueue_journals_job(limit=limit, logger=log))
    return {"status": f"generating up to {limit} journals"}


@router.post("/sessions", response_model=StatusResponse)
def job_sessions(
    _admin: None = Depends(require_admin),
    _rl: None = Depends(rate_limit("jobs-write", 10, 60)),
):
    if job_queue.is_job_type_active("sessions"):
        raise HTTPException(429, "Sessions job already in progress or queued.")
    _try_enqueue(_enqueue_sessions_compute)
    return {"status": "computing sessions"}


@router.post("/player-model", response_model=StatusResponse)
def job_player_model(
    _admin: None = Depends(require_admin),
    _rl: None = Depends(rate_limit("jobs-write", 10, 60)),
):
    if job_queue.is_job_type_active("player-model"):
        raise HTTPException(429, "Player model job already in progress or queued.")
    _try_enqueue(_enqueue_player_model)
    return {"status": "computing player model"}


@router.post("/weekly-report", response_model=StatusResponse)
def job_weekly_report(
    _admin: None = Depends(require_admin),
    _rl: None = Depends(rate_limit("jobs-write", 10, 60)),
):
    if job_queue.is_job_type_active("weekly-report"):
        raise HTTPException(429, "Weekly report job already in progress or queued.")
    _try_enqueue(_enqueue_weekly_report)
    return {"status": "generating weekly report"}


@router.post("/db-maintenance", response_model=JobActionResponse)
def job_db_maintenance(
    vacuum: bool = False,
    _admin: None = Depends(require_admin),
    _rl: None = Depends(rate_limit("jobs-write", 10, 60)),
):
    if job_queue.is_job_type_active("db-maintenance"):
        raise HTTPException(429, "DB maintenance job already in progress or queued.")
    _try_enqueue(lambda: _enqueue_db_maintenance(vacuum=vacuum))
    return {"status": "db maintenance queued", "vacuum": vacuum}


@router.get("/status", response_model=JobStatusResponse)
def jobs_status(
    _admin: None = Depends(require_admin),
    _rl: None = Depends(rate_limit("jobs-read", 120, 60)),
):
    return job_queue.get_current_job_status()
