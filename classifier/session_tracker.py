# classifier/session_tracker.py
import sqlite3
from config import DB_PATH


def compute_sessions():
    """
    Group games by calendar date. For each date, compute:
    - games played
    - result sequence (W/L/D) ordered by time
    - tilt detected: 2+ consecutive losses
    """
    conn = sqlite3.connect(DB_PATH)
    conn.execute("PRAGMA foreign_keys = ON")
    conn.execute("PRAGMA journal_mode=WAL")
    conn.row_factory = sqlite3.Row

    conn.execute("DELETE FROM sessions")

    # SQLite does not support ORDER BY inside GROUP_CONCAT.
    # Use a subquery that pre-orders by date, then GROUP_CONCAT picks up that order.
    days = conn.execute("""
        SELECT
            day,
            COUNT(*) AS games,
            GROUP_CONCAT(result, ',') AS results
        FROM (
            SELECT
                date(date) AS day,
                result
            FROM games
            ORDER BY date ASC
        )
        GROUP BY day
        ORDER BY day DESC
    """).fetchall()

    for row in days:
        results = row["results"].split(",") if row["results"] else []
        sequence = ",".join(r[0].upper() for r in results)

        # Tilt: any 2 consecutive losses in the sequence
        tilt = "L,L" in sequence

        wins = results.count("win")
        acc = round(wins / len(results), 3) if results else 0.0

        conn.execute("""
            INSERT INTO sessions (date, games_played, accuracy_avg, result_sequence, tilt_detected)
            VALUES (?, ?, ?, ?, ?)
        """, (row["day"], row["games"], acc, sequence, 1 if tilt else 0))

    conn.commit()

    tilt_days = conn.execute(
        "SELECT COUNT(*) FROM sessions WHERE tilt_detected=1"
    ).fetchone()[0]
    total = len(days)
    conn.close()

    print(f"Sessions computed: {total} days, {tilt_days} tilt days detected")


if __name__ == "__main__":
    compute_sessions()
