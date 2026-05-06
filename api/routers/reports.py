from fastapi import APIRouter, BackgroundTasks, HTTPException

from api.main import _COACH_OK # Import global variable, consider refactoring later
from api.services.job_enqueue_helpers import _enqueue_weekly_report


router = APIRouter(prefix="/api/reports", tags=["reports"])


@router.post("/weekly")
def generate_weekly(background_tasks: BackgroundTasks):
    # _COACH_OK is passed to the helper function now.
    _enqueue_weekly_report(background_tasks, _COACH_OK)
    return {"status": "generating"}
