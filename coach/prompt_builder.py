# coach/prompt_builder.py
import sqlite3
from config import DB_PATH, CHESS_USERNAME


def build_player_context() -> str:
    """
    Build a player profile summary string for injecting into chat system prompt.
    Covers overall stats, recent results, mistake patterns, worst openings.
    """
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")

    profile = conn.execute(
        "SELECT * FROM player_profile WHERE id=1"
    ).fetchone()

    top_mistakes = conn.execute("""
        SELECT type, COUNT(*) as cnt
        FROM mistakes
        GROUP BY type ORDER BY cnt DESC LIMIT 5
    """).fetchall()

    recent_results = conn.execute("""
        SELECT result, COUNT(*) as cnt
        FROM games
        WHERE date > datetime('now', '-14 days')
        GROUP BY result
    """).fetchall()

    worst_openings = conn.execute("""
        SELECT opening_eco, opening_name,
               COUNT(*) as games,
               SUM(CASE WHEN result='win' THEN 1 ELSE 0 END) as wins
        FROM games
        WHERE opening_eco IS NOT NULL AND analyzed=1
        GROUP BY opening_eco
        HAVING games >= 3
        ORDER BY (wins * 1.0 / games) ASC
        LIMIT 3
    """).fetchall()

    phase_mistakes = conn.execute("""
        SELECT phase, COUNT(*) as cnt
        FROM mistakes
        WHERE phase IS NOT NULL
        GROUP BY phase ORDER BY cnt DESC
    """).fetchall()

    srs_due = conn.execute(
        "SELECT COUNT(*) FROM srs_items WHERE due_date <= date('now')"
    ).fetchone()[0]

    conn.close()

    r = dict(profile) if profile else {}

    lines = [
        f"PLAYER: {CHESS_USERNAME} | Rating: {r.get('current_rating', 751)} Rapid 10+0",
        f"Games analyzed: {r.get('games_analyzed', 0)}",
        f"Hanging piece rate: {r.get('hanging_piece_rate', 0):.1%} (target <40%)",
        f"Blunders per game: {r.get('blunder_per_game', 0):.1f} (target <3)",
        "",
        "RECENT RESULTS (14 days):",
    ]
    lines += [f"  {row['result']}: {row['cnt']}" for row in recent_results]
    lines += ["", "TOP MISTAKE TYPES:"]
    lines += [f"  {row['type']}: {row['cnt']}" for row in top_mistakes]
    lines += ["", "MISTAKES BY PHASE:"]
    lines += [f"  {row['phase']}: {row['cnt']}" for row in phase_mistakes]
    lines += ["", "WORST OPENINGS (win rate, min 3 games):"]
    lines += [
        f"  {row['opening_eco']} {row['opening_name'] or ''}: "
        f"{row['wins']}/{row['games']} wins"
        for row in worst_openings
    ]
    lines += [f"", f"SRS DRILLS DUE TODAY: {srs_due}"]

    return "\n".join(lines)


def build_game_coaching_prompt(game_id: str) -> str:
    """
    Build a per-game coaching prompt for batch report generation.
    Uses FAST model — keep prompt tight and structured.
    """
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")

    game = conn.execute(
        "SELECT * FROM games WHERE id=?", (game_id,)
    ).fetchone()

    if not game:
        conn.close()
        return ""

    mistakes = conn.execute("""
        SELECT type, phase, played_move, best_move, eval_loss, is_critical
        FROM mistakes
        WHERE game_id=?
        ORDER BY is_critical DESC, eval_loss DESC
        LIMIT 3
    """, (game_id,)).fetchall()

    profile = conn.execute(
        "SELECT current_rating, hanging_piece_rate, blunder_per_game, weak_phase "
        "FROM player_profile WHERE id=1"
    ).fetchone()

    recent_stats = conn.execute("""
        SELECT
            ROUND(AVG(CASE WHEN result='win' THEN 1.0 ELSE 0.0 END) * 100, 1) as win_pct,
            COUNT(*) as game_count
        FROM games
        WHERE id != ? AND date > datetime('now', '-30 days')
    """, (game_id,)).fetchone()

    conn.close()

    p = dict(profile) if profile else {}
    rating     = p.get("current_rating", 751)
    hang_rate  = p.get("hanging_piece_rate", 0) or 0
    bpg        = p.get("blunder_per_game", 0) or 0
    weak_phase = p.get("weak_phase", "middlegame")

    mistakes_text = ""
    for i, m in enumerate(mistakes, 1):
        critical_marker = " ← CRITICAL (game turned here)" if m["is_critical"] else ""
        mistakes_text += (
            f"\n  {i}. {m['type'].replace('_', ' ').upper()} in {m['phase']}"
            f"\n     Played: {m['played_move']} | Better: {m['best_move']}"
            f"\n     Lost: {m['eval_loss']}cp{critical_marker}"
        )

    if not mistakes_text:
        mistakes_text = "\n  No significant mistakes detected."

    prompt = f"""You are a chess coach. Write a coaching note for a {rating}-rated beginner.

GAME: {game['color'].upper()} vs {game['opponent_rating']}-rated opponent
RESULT: {game['result'].upper()}
OPENING: {game['opening_name'] or 'Unknown'} ({game['opening_eco'] or '?'})
TOP MISTAKES:{mistakes_text}

PLAYER CONTEXT:
- Leaves pieces hanging in {hang_rate:.0%} of games
- Averages {bpg:.1f} blunders per game
- Weakest phase: {weak_phase}
- Recent 30 days: {recent_stats['game_count'] if recent_stats else 0} games, {recent_stats['win_pct'] if recent_stats else 0}% win rate

Write exactly this structure (under 130 words total):
WENT WELL: [one honest sentence, or "Nothing notable this game"]
FIX THIS: [the single most important mistake, name the piece and move]
NEXT GAME: [one concrete habit or question to apply, specific not generic]""".strip()

    return prompt


def build_critical_move_note_prompt(fen: str, played_move: str, best_move: str) -> str:
    """
    Build a focused prompt for Ollama to generate a concise coaching note
    for a single critical mistake.
    """
    prompt = f"""You are a helpful chess coach. Given a chess position, the move played by the student,
and the best move according to the engine, explain the mistake in 2-3 sentences.
Focus on *why* the played move was a mistake and *what* the best move achieves.
Do NOT use FEN notation in your explanation. Be encouraging.

FEN: {fen}
Student Played: {played_move}
Best Move: {best_move}

Explain the mistake:"""
    return prompt
