# reports/weekly_report.py
import sqlite3
from datetime import date, timedelta
from pathlib import Path
from config import DB_PATH, CHESS_USERNAME
from coach.ollama_client import generate as ollama_generate

REPORTS_DIR = Path("~/chess-coach/reports").expanduser()
REPORTS_DIR.mkdir(exist_ok=True)

def generate_weekly_report() -> str:
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row

    week_ago = (date.today() - timedelta(days=7)).isoformat()

    games = conn.execute("""
        SELECT COUNT(*) as total,
               SUM(CASE WHEN result='win' THEN 1 ELSE 0 END) as wins,
               SUM(CASE WHEN result='loss' THEN 1 ELSE 0 END) as losses,
               SUM(CASE WHEN result='draw' THEN 1 ELSE 0 END) as draws
        FROM games WHERE date >= ?
    """, (week_ago,)).fetchone()

    mistakes = conn.execute("""
        SELECT m.type, COUNT(*) as cnt
        FROM mistakes m
        JOIN games g ON m.game_id=g.id
        WHERE g.date >= ?
        GROUP BY m.type ORDER BY cnt DESC
    """, (week_ago,)).fetchall()

    profile = conn.execute(
        "SELECT * FROM player_profile WHERE id=1"
    ).fetchone()

    drills_reviewed = conn.execute("""
        SELECT COUNT(*) FROM srs_items
        WHERE last_reviewed >= ?
    """, (week_ago,)).fetchone()[0]

    conn.close()
    rating = profile["current_rating"] if profile and profile["current_rating"] is not None else 751
    hanging_rate = (
        f"{profile['hanging_piece_rate']:.1%}"
        if profile and profile["hanging_piece_rate"] is not None
        else "unknown"
    )
    mistake_breakdown = ", ".join(f"{m['type']}: {m['cnt']}" for m in mistakes) or "none"

    summary_prompt = f"""
Write a weekly chess improvement report for {CHESS_USERNAME}.

THIS WEEK:
- Games: {games['total']} ({games['wins']}W / {games['losses']}L / {games['draws']}D)
- Win rate: {round(games['wins']/games['total']*100, 1) if games['total'] else 0}%
- Mistake breakdown: {mistake_breakdown}
- Drills completed: {drills_reviewed}
- Current rating: {rating}
- Hanging piece rate: {hanging_rate}

Write in this exact format (keep it under 200 words):
## Week Summary
[2 sentences on overall performance]

## Top Problem This Week
[most critical mistake pattern with specific example advice]

## Study Plan for Next Week
[3 bullet points — specific, actionable, not generic]

## Encouraging Note
[1 sentence of genuine encouragement based on the numbers]
"""

    report_md = ollama_generate(summary_prompt)

    filename = REPORTS_DIR / f"week-{date.today().isoformat()}.md"
    filename.write_text(report_md)
    print(f"Report saved: {filename}")
    return report_md


if __name__ == "__main__":
    generate_weekly_report()
