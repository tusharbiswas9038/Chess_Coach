from typing import Any
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from api.dependencies import DRILLS_OK # New: import from dependencies
from drills.srs_scheduler import get_due_items, record_result, populate_srs_from_mistakes


router = APIRouter(prefix="/api/drills", tags=["drills"])


@router.get("/due")
def get_due_drills(limit: int = 15):
    if not DRILLS_OK:
        raise HTTPException(501, "Drills module not available yet")
    return get_due_items(limit=max(1, min(limit, 50)))


class DrillResult(BaseModel):
    item_id: int = Field(..., ge=1)
    quality: int = Field(..., ge=0, le=3)


@router.post("/result")
def submit_drill_result(result: DrillResult):
    if not DRILLS_OK:
        raise HTTPException(501, "Drills module not available yet")
    record_result(result.item_id, result.quality)
    return {"status": "ok"}


@router.post("/populate")
def populate_drills_from_mistakes():
    if not DRILLS_OK:
        raise HTTPException(501, "Drills module not available yet")
    populate_srs_from_mistakes()
    return {"status": "ok"}
