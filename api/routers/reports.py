from datetime import date, timedelta
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException

from api.dependencies import require_admin, rate_limit
from api.services.job_enqueue_helpers import _enqueue_weekly_report


router = APIRouter(prefix="/api/reports", tags=["reports"])

REPORTS_DIR = Path("reports")


def _read_report(target_date: date) -> dict | None:
    path = REPORTS_DIR / f"week-{target_date.isoformat()}.md"
    if not path.exists():
        return None
    try:
        text = path.read_text()
    except OSError:
        return None
    stat = path.stat()
    return {
        "date": target_date.isoformat(),
        "filename": path.name,
        "markdown": text,
        "generated_at": stat.st_mtime,
        "size_bytes": stat.st_size,
    }


def _list_recent_reports(limit: int = 8) -> list[dict]:
    if not REPORTS_DIR.exists():
        return []
    items = []
    for path in sorted(REPORTS_DIR.glob("week-*.md"), reverse=True)[:limit]:
        stem = path.stem.replace("week-", "")
        try:
            d = date.fromisoformat(stem)
        except ValueError:
            continue
        items.append(
            {
                "date": d.isoformat(),
                "filename": path.name,
                "size_bytes": path.stat().st_size,
                "generated_at": path.stat().st_mtime,
            }
        )
    return items


@router.post("/weekly")
def generate_weekly(
    _admin: None = Depends(require_admin),
    _rl: None = Depends(rate_limit("reports-write", 5, 60)),
):
    _enqueue_weekly_report()
    return {"status": "generating"}


@router.get("/weekly/latest")
def latest_weekly(
    _admin: None = Depends(require_admin),
    _rl: None = Depends(rate_limit("reports-read", 60, 60)),
):
    """Most recent weekly report (markdown + metadata) plus a list of recent files."""
    history = _list_recent_reports(limit=12)
    if not history:
        return {"latest": None, "previous": None, "history": []}

    latest_date = date.fromisoformat(history[0]["date"])
    previous_date = date.fromisoformat(history[1]["date"]) if len(history) > 1 else None
    latest = _read_report(latest_date)
    previous = _read_report(previous_date) if previous_date else None
    return {
        "latest": latest,
        "previous": previous,
        "history": history,
    }


@router.get("/weekly/{report_date}")
def get_weekly_report(
    report_date: str,
    _admin: None = Depends(require_admin),
    _rl: None = Depends(rate_limit("reports-read", 60, 60)),
):
    try:
        target = date.fromisoformat(report_date)
    except ValueError:
        raise HTTPException(400, "report_date must be YYYY-MM-DD")
    report = _read_report(target)
    if not report:
        raise HTTPException(404, "Report not found")
    return report
