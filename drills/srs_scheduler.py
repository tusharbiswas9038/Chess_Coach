# drills/srs_scheduler.py
import hashlib
import json
import sqlite3
from datetime import date, timedelta
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from config import DB_PATH


VALID_QUEUE_MODES = {"adaptive", "retry", "motif"}


def sm2_update(
    interval: float,
    ease: float,
    reps: int,
    quality: int  # 0=fail, 1=hard, 2=good, 3=easy (0-3 scale)
) -> tuple[float, float, int]:
    """
    Returns (new_interval_days, new_ease_factor, new_repetitions).
    quality: 0=again(fail), 1=hard, 2=good, 3=easy
    """
    if quality < 2:  # Failed or hard → reset
        return 1.0, max(1.3, ease - 0.2), 0

    if reps == 0:
        new_interval = 1.0
    elif reps == 1:
        new_interval = 4.0
    else:
        new_interval = interval * ease

    # Adjust ease factor
    ease_delta = 0.1 - (3 - quality) * (0.08 + (3 - quality) * 0.02)
    new_ease = max(1.3, ease + ease_delta)
    new_reps = reps + 1

    # Apply multipliers for easy/hard
    if quality == 3:
        new_interval *= 1.3
    elif quality == 1:
        new_interval *= 0.5

    return new_interval, new_ease, new_reps

def _difficulty(eval_loss: int | None) -> str:
    loss = int(eval_loss or 0)
    if loss >= 500:
        return "hard"
    if loss >= 250:
        return "medium"
    return "easy"


def _signature(fen: str, best_move: str) -> str:
    parts = (fen or "").split()
    stable_fen = " ".join(parts[:4]) if len(parts) >= 4 else fen
    return hashlib.sha256(f"{stable_fen}|{best_move}".encode("utf-8")).hexdigest()


def _fetch_drill_items(conn: sqlite3.Connection, item_ids: list[int], today: str) -> list[dict]:
    if not item_ids:
        return []
    placeholders = ",".join("?" for _ in item_ids)
    rows = conn.execute(f"""
        SELECT s.id, s.fen, s.correct_move, COALESCE(s.theme, p.motif) AS theme,
               s.interval_days, s.ease_factor, s.repetitions,
               s.due_date, s.last_reviewed, s.last_result,
               COALESCE(p.motif, m.mistake_subtype, m.type) as mistake_type,
               COALESCE(p.motif, m.mistake_subtype, m.type) as motif,
               COALESCE(p.phase, m.phase) as phase,
               COALESCE(p.difficulty, 'medium') as difficulty,
               g.date as game_date
        FROM srs_items s
        JOIN mistakes m ON s.mistake_id = m.id
        JOIN games g ON m.game_id = g.id
        LEFT JOIN puzzles p ON p.id = s.puzzle_id
        WHERE s.id IN ({placeholders})
    """, item_ids).fetchall()
    by_id = {int(r["id"]): dict(r) for r in rows}
    ordered = []
    for item_id in item_ids:
        row = by_id.get(int(item_id))
        if not row:
            continue
        row["completed_today"] = 1 if row.get("last_reviewed") == today else 0
        ordered.append(row)
    return ordered


def _priority_motifs(conn: sqlite3.Connection) -> list[str]:
    rows = conn.execute(
        """
        SELECT COALESCE(p.motif, m.mistake_subtype, m.type) AS motif,
               COUNT(*) AS cnt
        FROM srs_items s
        JOIN mistakes m ON m.id = s.mistake_id
        LEFT JOIN puzzles p ON p.id = s.puzzle_id
        WHERE s.last_reviewed >= date('now', '-14 days')
          AND s.last_result IN ('fail', 'hard')
        GROUP BY COALESCE(p.motif, m.mistake_subtype, m.type)
        ORDER BY cnt DESC
        LIMIT 3
        """
    ).fetchall()
    return [r["motif"] for r in rows if r["motif"]]


def _due_item_ids(
    conn: sqlite3.Connection,
    limit: int,
    today: str,
    mode: str = "adaptive",
    motif: str = "",
) -> list[int]:
    mode = mode if mode in VALID_QUEUE_MODES else "adaptive"
    motif = (motif or "").strip()
    priority_motifs = _priority_motifs(conn)
    where = ["s.due_date <= ?"]
    params: list = [today]
    if mode == "retry":
        where.append("s.last_result IN ('fail', 'hard')")
    if mode == "motif" and motif:
        where.append("COALESCE(p.motif, m.mistake_subtype, m.type) = ?")
        params.append(motif)
    priority_case = "0"
    if priority_motifs:
        placeholders = ",".join("?" for _ in priority_motifs)
        priority_case = f"CASE WHEN COALESCE(p.motif, m.mistake_subtype, m.type) IN ({placeholders}) THEN 0 ELSE 1 END"
        params.extend(priority_motifs)
    params.append(limit)
    rows = conn.execute(f"""
        SELECT s.id
        FROM srs_items s
        JOIN mistakes m ON s.mistake_id = m.id
        JOIN games g ON m.game_id = g.id
        LEFT JOIN puzzles p ON p.id = s.puzzle_id
        WHERE {' AND '.join(where)}
        ORDER BY
            {priority_case},
            CASE WHEN s.last_result IN ('fail', 'hard') THEN 0 ELSE 1 END,
            s.due_date ASC,
            CASE COALESCE(p.difficulty, 'medium') WHEN 'easy' THEN 2 WHEN 'medium' THEN 1 ELSE 0 END,
            s.ease_factor ASC
        LIMIT ?
    """, params).fetchall()
    return [int(r["id"]) for r in rows]


def get_due_items(
    limit: int = 15,
    refresh: bool = False,
    mode: str = "adaptive",
    motif: str = "",
) -> list[dict]:
    """Return today's server-backed drill session.

    A normal page load resumes the same daily queue. Explicit reload rebuilds
    the queue from currently due SRS items.
    """
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    today = date.today().isoformat()
    limit = max(1, min(int(limit or 15), 50))

    session = conn.execute(
        "SELECT item_ids FROM drill_sessions WHERE date=?",
        (today,),
    ).fetchone()

    item_ids: list[int]
    if session and not refresh:
        try:
            item_ids = [int(item_id) for item_id in json.loads(session["item_ids"])]
        except (TypeError, ValueError, json.JSONDecodeError):
            item_ids = []
    else:
        item_ids = []

    if not item_ids:
        item_ids = _due_item_ids(conn, limit, today, mode=mode, motif=motif)
        conn.execute(
            """
            INSERT INTO drill_sessions (date, item_ids, updated_at)
            VALUES (?, ?, datetime('now'))
            ON CONFLICT(date) DO UPDATE SET
                item_ids=excluded.item_ids,
                updated_at=excluded.updated_at
            """,
            (today, json.dumps(item_ids, separators=(",", ":"))),
        )
        conn.commit()

    items = _fetch_drill_items(conn, item_ids, today)
    conn.close()
    return items


def get_drill_summary(goal_target: int = 5) -> dict:
    """Return server-backed drill progress for consistent desktop/mobile state."""
    goal_target = max(1, min(int(goal_target or 5), 50))
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")

    today = date.today().isoformat()
    due_total = conn.execute(
        "SELECT COUNT(*) AS cnt FROM srs_items WHERE due_date <= date('now')"
    ).fetchone()["cnt"] or 0

    today_row = conn.execute(
        """
        SELECT
            COUNT(*) AS done,
            SUM(CASE WHEN last_result IN ('good', 'easy') THEN 1 ELSE 0 END) AS correct,
            SUM(CASE WHEN last_result IN ('fail', 'hard') THEN 1 ELSE 0 END) AS wrong
        FROM srs_items
        WHERE last_reviewed = ?
        """,
        (today,),
    ).fetchone()

    review_days = conn.execute(
        """
        SELECT last_reviewed AS day, COUNT(*) AS done
        FROM srs_items
        WHERE last_reviewed IS NOT NULL
        GROUP BY last_reviewed
        ORDER BY last_reviewed DESC
        LIMIT 365
        """
    ).fetchall()
    done_by_day = {r["day"]: int(r["done"] or 0) for r in review_days}

    streak = 0
    cursor = date.today()
    while done_by_day.get(cursor.isoformat(), 0) >= goal_target:
        streak += 1
        cursor -= timedelta(days=1)

    conn.close()
    done = int(today_row["done"] or 0)
    correct = int(today_row["correct"] or 0)
    wrong = int(today_row["wrong"] or 0)
    return {
        "due_total": int(due_total),
        "session_limit": 15,
        "goal_target": goal_target,
        "today": {
            "date": today,
            "done": done,
            "correct": correct,
            "wrong": wrong,
            "goal_done": done >= goal_target,
        },
        "streak": streak,
    }


def get_puzzle_summary() -> dict:
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    totals = conn.execute(
        """
        SELECT COUNT(*) AS total,
               SUM(CASE WHEN difficulty='easy' THEN 1 ELSE 0 END) AS easy,
               SUM(CASE WHEN difficulty='medium' THEN 1 ELSE 0 END) AS medium,
               SUM(CASE WHEN difficulty='hard' THEN 1 ELSE 0 END) AS hard
        FROM puzzles
        """
    ).fetchone()
    motifs = conn.execute(
        """
        SELECT motif, COUNT(*) AS count
        FROM puzzles
        WHERE motif IS NOT NULL AND TRIM(motif) <> ''
        GROUP BY motif
        ORDER BY count DESC, motif ASC
        LIMIT 20
        """
    ).fetchall()
    phases = conn.execute(
        """
        SELECT phase, COUNT(*) AS count
        FROM puzzles
        WHERE phase IS NOT NULL AND TRIM(phase) <> ''
        GROUP BY phase
        ORDER BY count DESC
        """
    ).fetchall()
    conn.close()
    return {
        "total": int(totals["total"] or 0),
        "difficulty": {
            "easy": int(totals["easy"] or 0),
            "medium": int(totals["medium"] or 0),
            "hard": int(totals["hard"] or 0),
        },
        "motifs": [dict(r) for r in motifs],
        "phases": [dict(r) for r in phases],
    }


def generate_puzzles_from_mistakes(limit: int = 500) -> dict:
    """Create deduped puzzle records and SRS links from analyzed mistakes."""
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    limit = max(1, min(int(limit or 500), 5000))

    mistakes = conn.execute(
        """
        SELECT id, fen, best_move, type, theme, COALESCE(mistake_subtype, type) AS motif,
               phase, eval_loss
        FROM mistakes
        WHERE best_move IS NOT NULL
          AND best_move <> '?'
          AND TRIM(best_move) <> ''
          AND eval_loss >= 100
        ORDER BY eval_loss DESC, id DESC
        LIMIT ?
        """,
        (limit,),
    ).fetchall()
    linked = 0
    srs_created = 0

    for row in mistakes:
        motif = row["theme"] or row["motif"] or row["type"]
        signature = _signature(row["fen"], row["best_move"])
        difficulty = _difficulty(row["eval_loss"])
        conn.execute(
            """
            INSERT INTO puzzles (signature, fen, best_move, motif, phase, difficulty, source_count)
            VALUES (?, ?, ?, ?, ?, ?, 1)
            ON CONFLICT(signature) DO UPDATE SET
                motif = COALESCE(puzzles.motif, excluded.motif),
                phase = COALESCE(puzzles.phase, excluded.phase),
                difficulty = excluded.difficulty,
                updated_at = datetime('now')
            """,
            (signature, row["fen"], row["best_move"], motif, row["phase"], difficulty),
        )
        puzzle = conn.execute(
            "SELECT id FROM puzzles WHERE signature=?",
            (signature,),
        ).fetchone()
        if not puzzle:
            continue
        puzzle_id = int(puzzle["id"])
        was_source = conn.execute(
            "SELECT 1 FROM puzzle_sources WHERE puzzle_id=? AND mistake_id=?",
            (puzzle_id, row["id"]),
        ).fetchone()
        conn.execute(
            """
            INSERT OR IGNORE INTO puzzle_sources (puzzle_id, mistake_id)
            VALUES (?, ?)
            """,
            (puzzle_id, row["id"]),
        )
        if not was_source:
            linked += 1
            conn.execute(
                """
                UPDATE puzzles
                SET source_count = (
                    SELECT COUNT(*) FROM puzzle_sources WHERE puzzle_id = ?
                )
                WHERE id = ?
                """,
                (puzzle_id, puzzle_id),
            )
        srs = conn.execute(
            "SELECT id FROM srs_items WHERE mistake_id=?",
            (row["id"],),
        ).fetchone()
        if srs:
            conn.execute("UPDATE srs_items SET puzzle_id=?, theme=COALESCE(theme, ?) WHERE id=?", (puzzle_id, motif, srs["id"]))
        else:
            conn.execute(
                """
                INSERT INTO srs_items (mistake_id, puzzle_id, fen, correct_move, theme)
                VALUES (?, ?, ?, ?, ?)
                """,
                (row["id"], puzzle_id, row["fen"], row["best_move"], motif),
            )
            srs_created += 1
    conn.commit()
    total = conn.execute("SELECT COUNT(*) AS cnt FROM puzzles").fetchone()["cnt"] or 0
    conn.close()
    return {
        "status": "ok",
        "processed": len(mistakes),
        "puzzles_total": int(total),
        "sources_linked": linked,
        "srs_created": srs_created,
    }

def record_result(item_id: int, quality: int):
    """
    quality: 0=fail(Again), 1=hard, 2=good, 3=easy
    Updates interval, ease, due_date.
    """
    conn = sqlite3.connect(DB_PATH)
    conn.execute("PRAGMA foreign_keys = ON")
    row = conn.execute(
        "SELECT interval_days, ease_factor, repetitions FROM srs_items WHERE id=?",
        (item_id,)
    ).fetchone()

    if not row:
        conn.close()
        return

    new_interval, new_ease, new_reps = sm2_update(
        row[0], row[1], row[2], quality
    )
    new_due = (date.today() + timedelta(days=round(new_interval))).isoformat()

    conn.execute("""
        UPDATE srs_items
        SET interval_days=?, ease_factor=?, repetitions=?,
            due_date=?, last_reviewed=?, last_result=?
        WHERE id=?
    """, (new_interval, new_ease, new_reps, new_due,
          date.today().isoformat(),
          {0:"fail",1:"hard",2:"good",3:"easy"}[quality],
          item_id))
    conn.commit()
    conn.close()

def populate_srs_from_mistakes():
    """Add new mistakes to SRS queue if not already there."""
    conn = sqlite3.connect(DB_PATH)
    conn.execute("PRAGMA foreign_keys = ON")
    new_mistakes = conn.execute("""
        SELECT m.id, m.fen, m.best_move, COALESCE(m.theme, m.mistake_subtype, m.type) AS theme
        FROM mistakes m
        LEFT JOIN srs_items s ON s.mistake_id = m.id
        WHERE s.id IS NULL
          AND m.eval_loss >= 200
    """).fetchall()

    for mistake_id, fen, best_move, theme in new_mistakes:
        conn.execute("""
            INSERT INTO srs_items (mistake_id, fen, correct_move, theme)
            VALUES (?, ?, ?, ?)
        """, (mistake_id, fen, best_move, theme))

    conn.commit()
    conn.close()
    print(f"Added {len(new_mistakes)} new drills to SRS queue.")
