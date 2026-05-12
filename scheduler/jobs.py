# scheduler/jobs.py
"""
Replaces n8n. Runs all automation jobs on schedule.
Start this as a separate process alongside uvicorn.
"""
import time
import logging
from datetime import datetime
from apscheduler.schedulers.blocking import BlockingScheduler
from apscheduler.triggers.cron import CronTrigger

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [scheduler] %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S"
)
log = logging.getLogger(__name__)

scheduler = BlockingScheduler(timezone="Asia/Kolkata")


# ── JOB 1: Nightly sync at 11:00 PM ──────────────────────────────
@scheduler.scheduled_job(CronTrigger(hour=23, minute=0))
def nightly_sync():
    log.info("Starting nightly sync...")
    try:
        from sync.fetch_games import sync_all
        result = sync_all(full=False)
        log.info(f"Sync done: {result}")
    except Exception as e:
        log.error(f"Sync failed: {e}")


# ── JOB 2: Analysis at 11:30 PM (after sync settles) ─────────────
@scheduler.scheduled_job(CronTrigger(hour=23, minute=30))
def nightly_analysis():
    log.info("Starting nightly analysis...")
    try:
        from engine.stockfish_worker import run_analysis_worker
        run_analysis_worker()
        log.info("Analysis complete")
    except Exception as e:
        log.error(f"Analysis failed: {e}")


# ── JOB 3: Populate SRS drills at 1:00 AM ────────────────────────
@scheduler.scheduled_job(CronTrigger(hour=1, minute=0))
def populate_drills():
    log.info("Populating SRS drill queue...")
    try:
        from drills.srs_scheduler import populate_srs_from_mistakes
        populate_srs_from_mistakes()
        log.info("SRS populated")
    except Exception as e:
        log.error(f"SRS populate failed: {e}")


# ── JOB 4: Generate coaching journals at 1:30 AM ─────────────────
@scheduler.scheduled_job(CronTrigger(hour=1, minute=30))
def nightly_journals():
    log.info("Generating coaching journals...")
    try:
        import sqlite3
        from config import DB_PATH
        from coach.game_report import generate_and_store_report

        conn = sqlite3.connect(DB_PATH)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA foreign_keys = ON")
        games = conn.execute("""
            SELECT g.id FROM games g
            LEFT JOIN journal_entries j ON j.game_id = g.id
            WHERE g.analyzed=1 AND j.id IS NULL
            ORDER BY g.date DESC
            LIMIT 15
        """).fetchall()
        conn.close()

        for row in games:
            try:
                generate_and_store_report(row["id"])
                log.info(f"  Journal: {row['id'][:16]}...")
            except Exception as e:
                log.error(f"  Journal failed {row['id'][:16]}: {e}")

        log.info(f"Journals done: {len(games)} generated")
    except Exception as e:
        log.error(f"Journal batch failed: {e}")


# ── JOB 5: Session tracker at 2:00 AM ────────────────────────────
@scheduler.scheduled_job(CronTrigger(hour=2, minute=0))
def compute_sessions():
    log.info("Computing session stats...")
    try:
        from classifier.session_tracker import compute_sessions
        compute_sessions()
        log.info("Sessions computed")
    except Exception as e:
        log.error(f"Session compute failed: {e}")


# ── JOB 6: Player model snapshot at 2:15 AM ──────────────────────
@scheduler.scheduled_job(CronTrigger(hour=2, minute=15))
def compute_player_model():
    log.info("Computing player model snapshot...")
    try:
        from api.services.player_model import compute_and_store_player_model_snapshot

        snapshot = compute_and_store_player_model_snapshot(source="scheduled")
        log.info(
            "Player model snapshot saved: id=%s games_analyzed=%s",
            snapshot["id"],
            snapshot["games_analyzed"],
        )
    except Exception as e:
        log.error(f"Player model snapshot failed: {e}")


# ── JOB 7: Weekly report every Sunday at 8:00 PM ─────────────────
@scheduler.scheduled_job(CronTrigger(day_of_week="sun", hour=20, minute=0))
def weekly_report():
    log.info("Generating weekly report...")
    try:
        from reports.weekly_report import generate_weekly_report
        generate_weekly_report()
        log.info("Weekly report saved")
    except Exception as e:
        log.error(f"Weekly report failed: {e}")


if __name__ == "__main__":
    log.info("Scheduler starting — all times in IST (Asia/Kolkata)")
    log.info("Jobs registered:")
    for job in scheduler.get_jobs():
        log.info(f"  {job.name} → {job.trigger}")
    scheduler.start()
