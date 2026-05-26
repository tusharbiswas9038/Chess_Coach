import hashlib
import sqlite3
from typing import Any, Dict, List

from config import CHESS_USERNAME, DB_PATH


def _rows(cursor_result) -> List[Dict[str, Any]]:
    return [dict(r) for r in cursor_result]


def _line_items(rows: List[Dict[str, Any]], formatter) -> List[str]:
    return [formatter(row) for row in rows] if rows else ["  None available yet."]


def build_coach_context(limit: int = 5) -> Dict[str, str]:
    """Build retrieval-enhanced local context for interactive coaching."""
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    limit = max(1, min(int(limit or 5), 10))

    profile = conn.execute("SELECT * FROM player_profile WHERE id=1").fetchone()
    player_model = conn.execute(
        """
        SELECT games_analyzed, current_rating, weak_phase, top_mistake_type,
               top_mistake_theme, favorite_opening_white, favorite_opening_black,
               computed_at
        FROM player_model_snapshots
        ORDER BY computed_at DESC
        LIMIT 1
        """
    ).fetchone()
    critical = _rows(conn.execute(
        """
        SELECT g.date, g.result, g.opening_eco, g.opening_name,
               m.type, COALESCE(m.mistake_subtype, m.type) AS subtype,
               m.phase, m.played_move, m.best_move, m.eval_loss,
               m.practical_impact, m.plan_text
        FROM mistakes m
        JOIN games g ON g.id = m.game_id
        WHERE m.is_critical = 1
        ORDER BY g.date DESC
        LIMIT ?
        """,
        (limit,),
    ).fetchall())
    motifs = _rows(conn.execute(
        """
        SELECT COALESCE(m.mistake_subtype, m.type) AS subtype,
               COALESCE(m.phase, 'unknown') AS phase,
               COUNT(*) AS count,
               ROUND(AVG(COALESCE(m.eval_loss, 0)), 1) AS avg_loss
        FROM mistakes m
        JOIN games g ON g.id = m.game_id
        WHERE g.date >= datetime('now', '-21 days')
        GROUP BY COALESCE(m.mistake_subtype, m.type), COALESCE(m.phase, 'unknown')
        ORDER BY count DESC, avg_loss DESC
        LIMIT ?
        """,
        (limit,),
    ).fetchall())
    opening_weaknesses = _rows(conn.execute(
        """
        SELECT opening_eco, COALESCE(MAX(NULLIF(opening_name, '')), 'Unknown') AS opening_name,
               color, COUNT(*) AS games,
               SUM(CASE WHEN result='win' THEN 1 ELSE 0 END) AS wins,
               ROUND(100.0 * SUM(CASE WHEN result='win' THEN 1 ELSE 0 END) / COUNT(*), 1) AS win_pct,
               SUM(COALESCE(mistake_count, 0)) AS mistakes
        FROM games
        WHERE analyzed = 1
          AND opening_eco IS NOT NULL
          AND TRIM(opening_eco) <> ''
        GROUP BY opening_eco, color
        HAVING games >= 2
        ORDER BY win_pct ASC, mistakes DESC, games DESC
        LIMIT ?
        """,
        (limit,),
    ).fetchall())
    drill_outcomes = conn.execute(
        """
        SELECT
            COUNT(*) AS reviewed_7d,
            SUM(CASE WHEN last_result IN ('good', 'easy') THEN 1 ELSE 0 END) AS correct_7d,
            SUM(CASE WHEN last_result IN ('fail', 'hard') THEN 1 ELSE 0 END) AS wrong_7d,
            SUM(CASE WHEN due_date <= date('now') THEN 1 ELSE 0 END) AS due_now
        FROM srs_items
        WHERE last_reviewed >= date('now', '-7 days')
           OR due_date <= date('now')
        """
    ).fetchone()
    conn.close()

    p = dict(profile) if profile else {}
    pm = dict(player_model) if player_model else {}
    d = dict(drill_outcomes) if drill_outcomes else {}
    reviewed = int(d.get("reviewed_7d") or 0)
    correct = int(d.get("correct_7d") or 0)
    accuracy = round((correct / reviewed) * 100) if reviewed else 0

    lines = [
        f"PLAYER: {CHESS_USERNAME}",
        f"Rating: {p.get('current_rating') or pm.get('current_rating') or 'unknown'}",
        f"Games analyzed: {p.get('games_analyzed') or pm.get('games_analyzed') or 0}",
        f"Blunders/game: {p.get('blunder_per_game') or 0}",
        f"Hanging piece rate: {p.get('hanging_piece_rate') or 0}",
        f"Player model weak phase: {pm.get('weak_phase') or p.get('weak_phase') or 'unknown'}",
        "",
        "RECENT CRITICAL MOMENTS:",
        *_line_items(
            critical,
            lambda r: (
                f"  {r['date']}: {r['subtype']} in {r['phase']} "
                f"({r['opening_eco'] or '?'}) played {r['played_move']} -> {r['best_move']}, "
                f"lost {r['eval_loss']}cp, impact={r.get('practical_impact') or 'unknown'}"
            ),
        ),
        "",
        "RECURRING MOTIFS (21 days):",
        *_line_items(
            motifs,
            lambda r: f"  {r['subtype']} in {r['phase']}: {r['count']}x, avg loss {r['avg_loss']}cp",
        ),
        "",
        "OPENING WEAK NODES:",
        *_line_items(
            opening_weaknesses,
            lambda r: (
                f"  {r['opening_eco']} {r['opening_name']} as {r['color']}: "
                f"{r['games']} games, {r['win_pct']}% wins, {r['mistakes']} mistakes"
            ),
        ),
        "",
        "DRILL OUTCOMES:",
        f"  Due now: {int(d.get('due_now') or 0)}",
        f"  Reviewed last 7 days: {reviewed}, accuracy: {accuracy}%, wrong/hard: {int(d.get('wrong_7d') or 0)}",
    ]
    text = "\n".join(lines)
    return {
        "text": text,
        "digest": hashlib.sha256(text.encode("utf-8")).hexdigest()[:16],
    }
