from typing import Any
import logging
from fastapi import APIRouter, HTTPException

from api.jobs_service import enqueue_journals_job
from api.main import _COACH_OK # Import global variable, consider refactoring later
from api.services.job_enqueue_helpers import (
    _enqueue_sync,
    _enqueue_analysis,
    _enqueue_sessions_compute,
    _enqueue_weekly_report,
)
from api.job_queue import job_queue # New import


router = APIRouter(prefix="/api/jobs", tags=["jobs"])
log = logging.getLogger("chess_coach.api.jobs.router")


@router.post("/sync")
def job_sync(): # Removed background_tasks
    if job_queue.is_job_type_active("sync"):
        raise HTTPException(429, "Sync job already in progress or queued.")
    _enqueue_sync(full=False) # Removed background_tasks
    return {"status": "sync started"}


@router.post("/analyze")
def job_analyze(): # Removed background_tasks
    if job_queue.is_job_type_active("analyze"):
        raise HTTPException(429, "Analysis job already in progress or queued.")
    _enqueue_analysis() # Removed background_tasks
    return {"status": "analysis started"}


@router.post("/journals")
def job_journals(limit: int = 15):
    if not _COACH_OK:
        raise HTTPException(501, "Coach not available")
    if job_queue.is_job_type_active("journals"):
        raise HTTPException(429, "Journals job already in progress or queued.")
    limit = max(1, min(limit, 50))
    enqueue_journals_job(limit=limit, logger=log)
    return {"status": f"generating up to {limit} journals"}


@router.post("/sessions")
def job_sessions(): # Removed background_tasks
    if job_queue.is_job_type_active("sessions"):
        raise HTTPException(429, "Sessions job already in progress or queued.")
    _enqueue_sessions_compute() # Removed background_tasks
    return {"status": "computing sessions"}


@router.post("/weekly-report")
def job_weekly_report(): # Removed background_tasks
    if job_queue.is_job_type_active("weekly-report"):
        raise HTTPException(429, "Weekly report job already in progress or queued.")
    _enqueue_weekly_report() # Removed background_tasks, _COACH_OK
    return {"status": "generating weekly report"}
