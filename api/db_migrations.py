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


def _column_names(conn: sqlite3.Connection, table: str) -> set[str]:
    return {r["name"] for r in conn.execute(f"PRAGMA table_info({table})").fetchall()}


def _add_column_if_missing(
    conn: sqlite3.Connection,
    table: str,
    column: str,
    definition: str,
) -> None:
    if column not in _column_names(conn, table):
        conn.execute(f"ALTER TABLE {table} ADD COLUMN {column} {definition}")


def _add_analysis_v2_fields(conn: sqlite3.Connection) -> None:
    for column, definition in (
        ("analysis_depth_policy", "TEXT"),
        ("candidate_alternatives", "TEXT"),
        ("plan_text", "TEXT"),
        ("practical_impact", "TEXT"),
        ("time_pressure_flag", "INTEGER DEFAULT 0"),
    ):
        _add_column_if_missing(conn, "moves", column, definition)

    for column, definition in (
        ("mistake_subtype", "TEXT"),
        ("confidence", "REAL"),
        ("practical_impact", "TEXT"),
        ("time_pressure_flag", "INTEGER DEFAULT 0"),
        ("candidate_alternatives", "TEXT"),
        ("plan_text", "TEXT"),
    ):
        _add_column_if_missing(conn, "mistakes", column, definition)

    conn.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_mistakes_subtype_phase_eval_loss
        ON mistakes(mistake_subtype, phase, eval_loss DESC)
        """
    )


def _create_drill_sessions(conn: sqlite3.Connection) -> None:
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS drill_sessions (
            date        TEXT PRIMARY KEY,
            item_ids    TEXT NOT NULL,
            created_at  TEXT DEFAULT (datetime('now')),
            updated_at  TEXT DEFAULT (datetime('now'))
        )
        """
    )


def _create_coach_quality_tables(conn: sqlite3.Connection) -> None:
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS coach_sessions (
            id               INTEGER PRIMARY KEY AUTOINCREMENT,
            created_at       TEXT DEFAULT (datetime('now')),
            mode             TEXT NOT NULL DEFAULT 'quick_answer',
            user_message     TEXT NOT NULL,
            assistant_reply  TEXT NOT NULL,
            context_digest   TEXT
        )
        """
    )
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS coach_feedback (
            id               INTEGER PRIMARY KEY AUTOINCREMENT,
            session_id       INTEGER REFERENCES coach_sessions(id) ON DELETE CASCADE,
            created_at       TEXT DEFAULT (datetime('now')),
            rating           INTEGER CHECK(rating BETWEEN 1 AND 5),
            feedback         TEXT
        )
        """
    )
    conn.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_coach_sessions_created_mode
        ON coach_sessions(created_at DESC, mode)
        """
    )


def _create_puzzle_ecosystem(conn: sqlite3.Connection) -> None:
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS puzzles (
            id             INTEGER PRIMARY KEY AUTOINCREMENT,
            signature      TEXT NOT NULL UNIQUE,
            fen            TEXT NOT NULL,
            best_move      TEXT NOT NULL,
            motif          TEXT,
            phase          TEXT,
            difficulty     TEXT NOT NULL DEFAULT 'medium',
            source_count   INTEGER NOT NULL DEFAULT 1,
            created_at     TEXT DEFAULT (datetime('now')),
            updated_at     TEXT DEFAULT (datetime('now'))
        )
        """
    )
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS puzzle_sources (
            puzzle_id      INTEGER NOT NULL REFERENCES puzzles(id) ON DELETE CASCADE,
            mistake_id     INTEGER NOT NULL REFERENCES mistakes(id) ON DELETE CASCADE,
            PRIMARY KEY (puzzle_id, mistake_id)
        )
        """
    )
    if "puzzle_id" not in _column_names(conn, "srs_items"):
        conn.execute("ALTER TABLE srs_items ADD COLUMN puzzle_id INTEGER REFERENCES puzzles(id) ON DELETE SET NULL")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_puzzles_motif_difficulty ON puzzles(motif, difficulty)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_puzzles_phase_motif ON puzzles(phase, motif)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_srs_due_puzzle ON srs_items(due_date, puzzle_id)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_srs_last_result_due ON srs_items(last_result, due_date)")


MIGRATIONS: List[Migration] = [
    ("001_cleanup_orphans_and_reconcile_indexes", _cleanup_orphan_srs_and_reconcile_indexes),
    ("002_optimize_indexes_for_hot_paths", _optimize_indexes_for_hot_paths),
    ("003_create_player_model_snapshots", _create_player_model_snapshots),
    ("004_analysis_v2_fields", _add_analysis_v2_fields),
    ("005_create_drill_sessions", _create_drill_sessions),
    ("006_create_coach_quality_tables", _create_coach_quality_tables),
    ("007_create_puzzle_ecosystem", _create_puzzle_ecosystem),
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
