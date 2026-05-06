import logging
import time

# from fastapi import BackgroundTasks # Removed
from api.db import db_conn
from api.job_queue import job_queue # New import


def enqueue_journals_job(
    # background_tasks: BackgroundTasks, # Removed
    *, limit: int, logger: logging.Logger
) -> None:
    def _run() -> None:
        from coach.game_report import generate_and_store_report

        with db_conn() as conn:
            games = conn.execute(
                """
                SELECT g.id FROM games g
                LEFT JOIN journal_entries j ON j.game_id = g.id
                WHERE g.analyzed=1 AND j.id IS NULL
                ORDER BY g.date DESC LIMIT ?
                """,
                (limit,),
            ).fetchall()

        logger.info("[job:journals] started candidates=%s limit=%s", len(games), limit)
        success = 0
        failed = 0
        for row in games:
            try:
                generate_and_store_report(row["id"])
                success += 1
            except Exception as e:
                failed += 1
                logger.exception("[job:journals] failed game_id=%s error=%s", row["id"], e)
        logger.info("[job:journals] completed success=%s failed=%s", success, failed)

    job_queue.enqueue_job(_run, job_id=f"journals-{time.time()}") # Changed from background_tasks.add_task


def enqueue_coach_game_job(
    # background_tasks: BackgroundTasks, # Removed
    *, game_id: str, logger: logging.Logger
) -> None:
    def _run() -> None:
        logger.info("[job:coach-game] started game_id=%s", game_id)
        try:
            from coach.game_report import generate_and_store_report

            report = generate_and_store_report(game_id)
            if report:
                logger.info("[job:coach-game] completed game_id=%s status=ok", game_id)
            else:
                logger.warning("[job:coach-game] completed game_id=%s status=empty", game_id)
        except Exception as e:
            logger.exception("[job:coach-game] failed game_id=%s error=%s", game_id, e)

    job_queue.enqueue_job(_run, job_id=f"coach-game-{game_id}") # Changed from background_tasks.add_task


def enqueue_coach_batch_job(
    # background_tasks: BackgroundTasks, # Removed
    *, limit: int, logger: logging.Logger
) -> None:
    def _run() -> None:
        with db_conn() as conn:
            games = conn.execute(
                """
                SELECT g.id FROM games g
                LEFT JOIN journal_entries j ON j.game_id = g.id
                WHERE g.analyzed=1 AND j.id IS NULL
                ORDER BY g.date DESC
                LIMIT ?
                """,
                (limit,),
            ).fetchall()

        from coach.game_report import generate_and_store_report

        success = 0
        failed = 0
        batch_start = time.time()
        logger.info("[job:coach-batch] started candidates=%s limit=%s", len(games), limit)

        for row in games:
            for attempt in range(2):
                try:
                    t0 = time.time()
                    generate_and_store_report(row["id"])
                    elapsed = time.time() - t0
                    success += 1
                    logger.info(
                        "[job:coach-batch] report_ok game_id=%s attempt=%s elapsed=%.2fs",
                        row["id"],
                        attempt + 1,
                        elapsed,
                    )
                    time.sleep(3)
                    break
                except Exception as e:
                    if attempt == 0:
                        logger.warning(
                            "[job:coach-batch] retry game_id=%s error=%s",
                            row["id"],
                            e,
                        )
                        time.sleep(10)
                    else:
                        logger.exception(
                            "[job:coach-batch] failed game_id=%s error=%s",
                            row["id"],
                            e,
                        )
                        failed += 1

        total = time.time() - batch_start
        logger.info(
            "[job:coach-batch] completed success=%s failed=%s total_sec=%.1f",
            success,
            failed,
            total,
        )

    job_queue.enqueue_job(_run, job_id=f"coach-batch-{time.time()}") # Changed from background_tasks.add_task
