# drills/srs_scheduler.py
import json
import sqlite3
from datetime import date, timedelta
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from config import DB_PATH


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

def _fetch_drill_items(conn: sqlite3.Connection, item_ids: list[int], today: str) -> list[dict]:
    if not item_ids:
        return []
    placeholders = ",".join("?" for _ in item_ids)
    rows = conn.execute(f"""
        SELECT s.id, s.fen, s.correct_move, s.theme,
               s.interval_days, s.ease_factor, s.repetitions,
               s.due_date, s.last_reviewed, s.last_result,
               m.type as mistake_type, g.date as game_date
        FROM srs_items s
        JOIN mistakes m ON s.mistake_id = m.id
        JOIN games g ON m.game_id = g.id
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


def _due_item_ids(conn: sqlite3.Connection, limit: int, today: str) -> list[int]:
    rows = conn.execute("""
        SELECT s.id
        FROM srs_items s
        JOIN mistakes m ON s.mistake_id = m.id
        JOIN games g ON m.game_id = g.id
        WHERE s.due_date <= ?
        ORDER BY s.due_date ASC, s.ease_factor ASC
        LIMIT ?
    """, (today, limit)).fetchall()
    return [int(r["id"]) for r in rows]


def get_due_items(limit: int = 15, refresh: bool = False) -> list[dict]:
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
        item_ids = _due_item_ids(conn, limit, today)
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
        SELECT m.id, m.fen, m.best_move, m.theme
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
