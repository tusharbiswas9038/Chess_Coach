from fastapi import APIRouter, BackgroundTasks, HTTPException

from api.dependencies import COACH_OK # New: import from dependencies
from api.services.job_enqueue_helpers import _enqueue_weekly_report


router = APIRouter(prefix="/api/reports", tags=["reports"])


@router.post("/weekly")
def generate_weekly(): # Removed background_tasks
    # _COACH_OK is passed to the helper function now.
    _enqueue_weekly_report() # No params needed now
    return {"status": "generating"}
