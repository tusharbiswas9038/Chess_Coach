import logging
import sqlite3
from pathlib import Path
from typing import Callable, List, Tuple

from config import DB_PATH

log = logging.getLogger("chess_coach.db.migrations")

Migration = Tuple[str, Callable[[sqlite3.Connection], None]]


def _ensure_migrations_table(conn: sqlite3.Connection) -> None:
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS schema_migrations (
            id TEXT PRIMARY KEY,
            applied_at TEXT DEFAULT (datetime('now'))
        )
        """
    )


def _cleanup_orphan_srs_and_reconcile_indexes(conn: sqlite3.Connection) -> None:
    # Remove orphan drills created while foreign_keys pragma was not consistently enabled.
    conn.execute(
        """
        DELETE FROM srs_items
        WHERE mistake_id NOT IN (SELECT id FROM mistakes)
        """
    )

    # Reconcile opening index with current query shape and schema.sql intention.
    conn.execute("DROP INDEX IF EXISTS idx_games_opening_eco_analyzed")
    conn.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_games_opening_eco_color_analyzed
        ON games(opening_eco, color, analyzed)
        """
    )

    # Align with schema.sql; harmless if unused.
    conn.execute("CREATE INDEX IF NOT EXISTS idx_moves_ply ON moves(ply)")


def _optimize_indexes_for_hot_paths(conn: sqlite3.Connection) -> None:
    # journal_entries.game_id already has uniqueness via table constraint / autoindex.
    # Remove redundant non-unique index to reduce write overhead and schema noise.
    conn.execute("DROP INDEX IF EXISTS idx_journal_entries_game_id")

    # Speeds up common game-centric mistake review queries.
    conn.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_mistakes_game_type_eval_loss
        ON mistakes(game_id, type, eval_loss DESC)
        """
    )


def _create_player_model_snapshots(conn: sqlite3.Connection) -> None:
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS player_model_snapshots (
            id                      INTEGER PRIMARY KEY AUTOINCREMENT,
            computed_at             TEXT DEFAULT (datetime('now')),
            source                  TEXT NOT NULL DEFAULT 'job',
            games_analyzed          INTEGER NOT NULL DEFAULT 0,
            window_days             INTEGER NOT NULL DEFAULT 90,
            current_rating          INTEGER,
            blunders_per_game       REAL,
            hanging_piece_rate      REAL,
            weak_phase              TEXT,
            top_mistake_type        TEXT,
            top_mistake_theme       TEXT,
            favorite_opening_white  TEXT,
            favorite_opening_black  TEXT,
            style_tactical          REAL,
            style_attacking         REAL,
            style_solid             REAL,
            payload_json            TEXT NOT NULL
        )
        """
    )
    conn.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_player_model_snapshots_computed_at
        ON player_model_snapshots(computed_at DESC)
        """
    )


MIGRATIONS: List[Migration] = [
    ("001_cleanup_orphans_and_reconcile_indexes", _cleanup_orphan_srs_and_reconcile_indexes),
    ("002_optimize_indexes_for_hot_paths", _optimize_indexes_for_hot_paths),
    ("003_create_player_model_snapshots", _create_player_model_snapshots),
]


def run_pending_migrations(db_path: Path = DB_PATH) -> List[str]:
    conn = sqlite3.connect(str(db_path), timeout=30)
    conn.execute("PRAGMA foreign_keys = ON")
    conn.row_factory = sqlite3.Row
    applied: List[str] = []

    try:
        _ensure_migrations_table(conn)
        existing = {
            r["id"] for r in conn.execute("SELECT id FROM schema_migrations").fetchall()
        }
        for migration_id, migration_fn in MIGRATIONS:
            if migration_id in existing:
                continue
            log.info("Applying DB migration %s", migration_id)
            conn.execute("BEGIN")
            try:
                migration_fn(conn)
                conn.execute(
                    "INSERT INTO schema_migrations (id) VALUES (?)",
                    (migration_id,),
                )
                conn.commit()
                applied.append(migration_id)
            except Exception:
                conn.rollback()
                raise
    finally:
        conn.close()

    if applied:
        log.info("Applied DB migrations: %s", ", ".join(applied))
    else:
        log.info("No pending DB migrations.")
    return applied
