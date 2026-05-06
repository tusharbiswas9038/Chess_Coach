import logging
from api.job_queue import job_queue # New import

from sync.fetch_games import sync_all
from engine.stockfish_worker import run_analysis_worker
from classifier.session_tracker import compute_sessions # Local import
from reports.weekly_report import generate_weekly_report # Local import
from api.main import _COACH_OK # Import _COACH_OK from main

log = logging.getLogger("chess_coach.api.jobs")


def _enqueue_sync(full: bool = False) -> None: # Removed background_tasks
    log.info("[job:sync] queued full=%s", full)
    job_queue.enqueue_job(sync_all, full, job_id="sync") # Changed


def _enqueue_analysis() -> None: # Removed background_tasks
    log.info("[job:analyze] queued")
    job_queue.enqueue_job(run_analysis_worker, job_id="analyze") # Changed


def _enqueue_sessions_compute() -> None: # Removed background_tasks
    log.info("[job:sessions] queued")
    job_queue.enqueue_job(compute_sessions, job_id="sessions") # Changed


def _enqueue_weekly_report() -> None: # Removed background_tasks and _COACH_OK from signature
    if not _COACH_OK:
        log.warning("[job:weekly-report] Coach not available, cannot enqueue.")
        return
    log.info("[job:weekly-report] queued")
    job_queue.enqueue_job(generate_weekly_report, job_id="weekly-report") # Changed
