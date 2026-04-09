# drills/srs_scheduler.py
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

def get_due_items(limit: int = 15) -> list[dict]:
    """Return SRS items due today, ordered by most overdue first."""
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    today = date.today().isoformat()

    rows = conn.execute("""
        SELECT s.id, s.fen, s.correct_move, s.theme,
               s.interval_days, s.ease_factor, s.repetitions,
               s.due_date, m.type as mistake_type, g.date as game_date
        FROM srs_items s
        JOIN mistakes m ON s.mistake_id = m.id
        JOIN games g ON m.game_id = g.id
        WHERE s.due_date <= ?
        ORDER BY s.due_date ASC, s.ease_factor ASC
        LIMIT ?
    """, (today, limit)).fetchall()

    conn.close()
    return [dict(r) for r in rows]

def record_result(item_id: int, quality: int):
    """
    quality: 0=fail(Again), 1=hard, 2=good, 3=easy
    Updates interval, ease, due_date.
    """
    conn = sqlite3.connect(DB_PATH)
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
