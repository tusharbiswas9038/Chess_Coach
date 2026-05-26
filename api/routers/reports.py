from fastapi import APIRouter, Depends

from api.dependencies import require_admin, rate_limit
from api.services.job_enqueue_helpers import _enqueue_weekly_report


router = APIRouter(prefix="/api/reports", tags=["reports"])


@router.post("/weekly")
def generate_weekly(
    _admin: None = Depends(require_admin),
    _rl: None = Depends(rate_limit("reports-write", 5, 60)),
):
    _enqueue_weekly_report()
    return {"status": "generating"}
