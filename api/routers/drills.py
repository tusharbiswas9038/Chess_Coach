from typing import Any
import time
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from api.dependencies import DRILLS_OK, rate_limit, require_admin # New: import from dependencies
from api.services.cache_service import clear_analytics_caches
from api.job_queue import job_queue
from drills.srs_scheduler import (
    VALID_QUEUE_MODES,
    generate_puzzles_from_mistakes,
    get_drill_summary,
    get_due_items,
    get_puzzle_summary,
    populate_srs_from_mistakes,
    record_result,
)


router = APIRouter(prefix="/api/drills", tags=["drills"])


@router.get("/due")
def get_due_drills(
    limit: int = 15,
    refresh: bool = False,
    mode: str = "adaptive",
    motif: str = "",
    _rl: None = Depends(rate_limit("drills-read", 120, 60)),
):
    if not DRILLS_OK:
        raise HTTPException(501, "Drills module not available yet")
    if mode not in VALID_QUEUE_MODES:
        mode = "adaptive"
    return get_due_items(
        limit=max(1, min(limit, 50)),
        refresh=refresh,
        mode=mode,
        motif=motif,
    )


@router.get("/summary")
def drill_summary(
    goal_target: int = 5,
    _rl: None = Depends(rate_limit("drills-read", 120, 60)),
):
    if not DRILLS_OK:
        raise HTTPException(501, "Drills module not available yet")
    return get_drill_summary(goal_target=goal_target)


@router.get("/puzzles/summary")
def puzzle_summary(
    _rl: None = Depends(rate_limit("drills-read", 120, 60)),
):
    if not DRILLS_OK:
        raise HTTPException(501, "Drills module not available yet")
    return get_puzzle_summary()


class DrillResult(BaseModel):
    item_id: int = Field(..., ge=1)
    quality: int = Field(..., ge=0, le=3)


@router.post("/result")
def submit_drill_result(
    result: DrillResult,
    _admin: None = Depends(require_admin),
    _rl: None = Depends(rate_limit("drills-write", 60, 60)),
):
    if not DRILLS_OK:
        raise HTTPException(501, "Drills module not available yet")
    record_result(result.item_id, result.quality)
    clear_analytics_caches()
    return {"status": "ok", "summary": get_drill_summary()}


@router.post("/populate")
def populate_drills_from_mistakes(
    _admin: None = Depends(require_admin),
    _rl: None = Depends(rate_limit("drills-write", 10, 60)),
):
    if not DRILLS_OK:
        raise HTTPException(501, "Drills module not available yet")
    populate_srs_from_mistakes()
    clear_analytics_caches()
    return {"status": "ok"}


@router.post("/generate-puzzles")
def generate_puzzle_job(
    limit: int = 500,
    _admin: None = Depends(require_admin),
    _rl: None = Depends(rate_limit("drills-write", 5, 60)),
):
    if not DRILLS_OK:
        raise HTTPException(501, "Drills module not available yet")
    if job_queue.is_job_type_active("puzzles"):
        raise HTTPException(429, "Puzzle generation already in progress or queued.")

    def _run() -> dict:
        result = generate_puzzles_from_mistakes(limit=max(1, min(limit, 5000)))
        clear_analytics_caches()
        return {
            **result,
            "invalidates": ["analytics", "dashboard", "training"],
            "event": "puzzles-generated",
            "source": "drills",
        }

    job_queue.enqueue_job(_run, job_id=f"puzzles-{time.time()}")
    return {"status": "puzzle generation queued"}
