from typing import Any
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from api.dependencies import DRILLS_OK, rate_limit, require_admin # New: import from dependencies
from api.services.cache_service import clear_analytics_caches
from drills.srs_scheduler import (
    get_drill_summary,
    get_due_items,
    populate_srs_from_mistakes,
    record_result,
)


router = APIRouter(prefix="/api/drills", tags=["drills"])


@router.get("/due")
def get_due_drills(limit: int = 15, _rl: None = Depends(rate_limit("drills-read", 120, 60))):
    if not DRILLS_OK:
        raise HTTPException(501, "Drills module not available yet")
    return get_due_items(limit=max(1, min(limit, 50)))


@router.get("/summary")
def drill_summary(
    goal_target: int = 5,
    _rl: None = Depends(rate_limit("drills-read", 120, 60)),
):
    if not DRILLS_OK:
        raise HTTPException(501, "Drills module not available yet")
    return get_drill_summary(goal_target=goal_target)


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
