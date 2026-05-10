from typing import Any
import logging
from fastapi import APIRouter, HTTPException, Request

from api.jobs_service import enqueue_journals_job
from api.dependencies import COACH_OK # New: import from dependencies
from api.services.job_enqueue_helpers import (
    _enqueue_sync,
    _enqueue_analysis,
    _enqueue_sessions_compute,
    _enqueue_weekly_report,
    _enqueue_db_maintenance,
)
from api.job_queue import job_queue # New import
from api.security import enforce_rate_limit, require_admin_if_configured


router = APIRouter(prefix="/api/jobs", tags=["jobs"])
log = logging.getLogger("chess_coach.api.jobs.router")


@router.post("/sync")
def job_sync(request: Request): # Removed background_tasks
    require_admin_if_configured(request)
    enforce_rate_limit(request, bucket="jobs-write", limit=10, window_sec=60)
    if job_queue.is_job_type_active("sync"):
        raise HTTPException(429, "Sync job already in progress or queued.")
    try:
        _enqueue_sync(full=False) # Removed background_tasks
    except RuntimeError as e:
        raise HTTPException(429, str(e))
    return {"status": "sync started"}


@router.post("/analyze")
def job_analyze(request: Request): # Removed background_tasks
    require_admin_if_configured(request)
    enforce_rate_limit(request, bucket="jobs-write", limit=10, window_sec=60)
    if job_queue.is_job_type_active("analyze"):
        raise HTTPException(429, "Analysis job already in progress or queued.")
    try:
        _enqueue_analysis() # Removed background_tasks
    except RuntimeError as e:
        raise HTTPException(429, str(e))
    return {"status": "analysis started"}


@router.post("/journals")
def job_journals(request: Request, limit: int = 15):
    require_admin_if_configured(request)
    enforce_rate_limit(request, bucket="jobs-write", limit=10, window_sec=60)
    if not COACH_OK:
        raise HTTPException(501, "Coach not available")
    if job_queue.is_job_type_active("journals"):
        raise HTTPException(429, "Journals job already in progress or queued.")
    limit = max(1, min(limit, 50))
    try:
        enqueue_journals_job(limit=limit, logger=log)
    except RuntimeError as e:
        raise HTTPException(429, str(e))
    return {"status": f"generating up to {limit} journals"}


@router.post("/sessions")
def job_sessions(request: Request): # Removed background_tasks
    require_admin_if_configured(request)
    enforce_rate_limit(request, bucket="jobs-write", limit=10, window_sec=60)
    if job_queue.is_job_type_active("sessions"):
        raise HTTPException(429, "Sessions job already in progress or queued.")
    try:
        _enqueue_sessions_compute() # Removed background_tasks
    except RuntimeError as e:
        raise HTTPException(429, str(e))
    return {"status": "computing sessions"}


@router.post("/weekly-report")
def job_weekly_report(request: Request): # Removed background_tasks
    require_admin_if_configured(request)
    enforce_rate_limit(request, bucket="jobs-write", limit=10, window_sec=60)
    if job_queue.is_job_type_active("weekly-report"):
        raise HTTPException(429, "Weekly report job already in progress or queued.")
    try:
        _enqueue_weekly_report() # Removed background_tasks, _COACH_OK
    except RuntimeError as e:
        raise HTTPException(429, str(e))
    return {"status": "generating weekly report"}


@router.post("/db-maintenance")
def job_db_maintenance(request: Request, vacuum: bool = False):
    require_admin_if_configured(request)
    enforce_rate_limit(request, bucket="jobs-write", limit=10, window_sec=60)
    if job_queue.is_job_type_active("db-maintenance"):
        raise HTTPException(429, "DB maintenance job already in progress or queued.")
    try:
        _enqueue_db_maintenance(vacuum=vacuum)
    except RuntimeError as e:
        raise HTTPException(429, str(e))
    return {"status": "db maintenance queued", "vacuum": vacuum}


@router.get("/status")
def jobs_status(request: Request):
    enforce_rate_limit(request, bucket="jobs-read", limit=120, window_sec=60)
    return job_queue.get_current_job_status()
