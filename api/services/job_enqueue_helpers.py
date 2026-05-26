import logging
from api.job_queue import job_queue # New import
from api.services.cache_service import clear_analytics_caches

from sync.fetch_games import sync_all
from engine.stockfish_worker import run_analysis_worker
from classifier.session_tracker import compute_sessions # Local import
from reports.weekly_report import generate_weekly_report # Local import
from scripts.db_maintenance import run_maintenance
from api.dependencies import COACH_OK # New Import from dependencies
from api.services.player_model import compute_and_store_player_model_snapshot

log = logging.getLogger("chess_coach.api.jobs")

ANALYTICS_INVALIDATION_SCOPES = ["analytics", "dashboard", "games", "openings", "mistakes", "training"]


def _completion_payload(source: str) -> dict:
    return {
        "invalidates": ANALYTICS_INVALIDATION_SCOPES,
        "event": "analytics:invalidated",
        "source": source,
    }


def _enqueue_sync(full: bool = False) -> None: # Removed background_tasks
    log.info("[job:sync] queued full=%s", full)
    job_queue.enqueue_job(sync_all_and_clear_cache, full, job_id="sync") # Changed


def _enqueue_analysis() -> None: # Removed background_tasks
    log.info("[job:analyze] queued")
    job_queue.enqueue_job(run_analysis_worker_and_clear_cache, job_id="analyze") # Changed


def _enqueue_sessions_compute() -> None: # Removed background_tasks
    log.info("[job:sessions] queued")
    job_queue.enqueue_job(compute_sessions_and_clear_cache, job_id="sessions") # Changed


def _enqueue_player_model() -> None:
    log.info("[job:player-model] queued")
    job_queue.enqueue_job(compute_player_model_and_clear_cache, job_id="player-model")


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
    compute_and_store_player_model_snapshot(source="sync")
    clear_analytics_caches()
    log.info("Cleared analytics caches after sync job.")
    return _completion_payload("sync")

def run_analysis_worker_and_clear_cache() -> None:
    run_analysis_worker()
    compute_and_store_player_model_snapshot(source="analysis")
    clear_analytics_caches()
    log.info("Cleared analytics caches after analysis job.")
    return _completion_payload("analyze")

def compute_sessions_and_clear_cache() -> None:
    compute_sessions()
    clear_analytics_caches()
    log.info("Cleared analytics caches after sessions job.")
    return _completion_payload("sessions")

def compute_player_model_and_clear_cache() -> None:
    compute_and_store_player_model_snapshot(source="manual")
    clear_analytics_caches()
    log.info("Cleared analytics caches after player model job.")
    return _completion_payload("player-model")

def generate_weekly_report_and_clear_cache() -> None:
    generate_weekly_report()
    clear_analytics_caches()
    log.info("Cleared analytics caches after weekly report job.")
    return _completion_payload("weekly-report")


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
    return {"invalidates": ["database"], "event": "database:optimized", "source": "db-maintenance"}
