import logging
from api.job_queue import job_queue # New import
from api.routers.stats import clear_stats_cache # New import

from sync.fetch_games import sync_all
from engine.stockfish_worker import run_analysis_worker
from classifier.session_tracker import compute_sessions # Local import
from reports.weekly_report import generate_weekly_report # Local import
from scripts.db_maintenance import run_maintenance
from api.dependencies import COACH_OK # New Import from dependencies

log = logging.getLogger("chess_coach.api.jobs")


def _enqueue_sync(full: bool = False) -> None: # Removed background_tasks
    log.info("[job:sync] queued full=%s", full)
    job_queue.enqueue_job(sync_all_and_clear_cache, full, job_id="sync") # Changed


def _enqueue_analysis() -> None: # Removed background_tasks
    log.info("[job:analyze] queued")
    job_queue.enqueue_job(run_analysis_worker_and_clear_cache, job_id="analyze") # Changed


def _enqueue_sessions_compute() -> None: # Removed background_tasks
    log.info("[job:sessions] queued")
    job_queue.enqueue_job(compute_sessions_and_clear_cache, job_id="sessions") # Changed


def _enqueue_weekly_report() -> None: # Removed background_tasks and _COACH_OK from signature
    if not COACH_OK:
        log.warning("[job:weekly-report] Coach not available, cannot enqueue.")
        return
    log.info("[job:weekly-report] queued")
    job_queue.enqueue_job(generate_weekly_report_and_clear_cache, job_id="weekly-report") # Changed


def _enqueue_db_maintenance(vacuum: bool = False) -> None:
    log.info("[job:db-maintenance] queued vacuum=%s", vacuum)
    job_queue.enqueue_job(
        db_maintenance_job,
        vacuum,
        job_id=f"db-maintenance{'-vacuum' if vacuum else ''}",
    )


# Wrapper functions to clear cache after job completion
def sync_all_and_clear_cache(full: bool) -> None:
    sync_all(full)
    clear_stats_cache()
    log.info("Cleared stats cache after sync job.")

def run_analysis_worker_and_clear_cache() -> None:
    run_analysis_worker()
    clear_stats_cache()
    log.info("Cleared stats cache after analysis job.")

def compute_sessions_and_clear_cache() -> None:
    compute_sessions()
    clear_stats_cache()
    log.info("Cleared stats cache after sessions job.")

def generate_weekly_report_and_clear_cache() -> None:
    generate_weekly_report()
    clear_stats_cache()
    log.info("Cleared stats cache after weekly report job.")


def db_maintenance_job(vacuum: bool = False) -> None:
    result = run_maintenance(analyze=True, vacuum=vacuum)
    log.info(
        "[job:db-maintenance] completed analyze=%s vacuum=%s integrity=%s fk_violations=%s size_mb=%.2f",
        result["analyze"],
        result["vacuum"],
        result["integrity_check"],
        result["foreign_key_violations"],
        result["estimated_size_mb"],
    )
