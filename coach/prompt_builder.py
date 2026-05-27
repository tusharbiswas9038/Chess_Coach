# coach/prompt_builder.py
import sqlite3
from config import DB_PATH, CHESS_USERNAME


COACH_MODE_POLICIES = {
    "quick_answer": {
        "label": "Quick answer",
        "num_predict": 350,
        "template": (
            "Answer in 3 compact sections:\n"
            "1. DIAGNOSIS: one sentence.\n"
            "2. DO THIS NOW: 2 concrete actions.\n"
            "3. NEXT GAME RULE: one memorable rule."
        ),
    },
    "deep_lesson": {
        "label": "Deep lesson",
        "num_predict": 650,
        "template": (
            "Teach like a patient chess coach. Use this structure:\n"
            "WHY IT HAPPENS, EXAMPLE FROM MY DATA, TRAINING DRILL, NEXT GAME CHECKLIST.\n"
            "Keep it practical and avoid vague encouragement."
        ),
    },
    "pre_game_prep": {
        "label": "Pre-game prep",
        "num_predict": 450,
        "template": (
            "Create a pre-game plan. Use exactly:\n"
            "OPENING WARNING, TACTICAL CHECK, TIME CONTROL PLAN, 3-GAME FOCUS."
        ),
    },
    "post_loss_reset": {
        "label": "Post-loss reset",
        "num_predict": 450,
        "template": (
            "Help the player recover after a loss. Use exactly:\n"
            "RESET, ONE LESSON, ONE DRILL, STOP CONDITION.\n"
            "Be calm, direct, and avoid emotional over-analysis."
        ),
    },
}


MEMORY_SESSION_LIMIT = 8
MEMORY_PREVIEW_CHARS = 240


def normalize_coach_mode(mode: str | None) -> str:
    return mode if mode in COACH_MODE_POLICIES else "quick_answer"


def build_coach_memory_preamble(limit: int = MEMORY_SESSION_LIMIT) -> str:
    """
    Returns a short, dated digest of recent coach sessions so the LLM has
    continuity across chats. Highly-rated sessions are favored; thumbs-down
    sessions are excluded so we don't reinforce advice the user rejected.
    """
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    try:
        rows = conn.execute(
            """
            SELECT
                substr(created_at, 1, 10) AS day,
                mode,
                substr(user_message, 1, 160) AS user_excerpt,
                substr(assistant_reply, 1, 240) AS assistant_excerpt,
                COALESCE(user_rating, 0) AS rating
            FROM coach_sessions
            WHERE COALESCE(user_rating, 0) >= 0
            ORDER BY rating DESC, created_at DESC
            LIMIT ?
            """,
            (max(1, int(limit)),),
        ).fetchall()
    except sqlite3.OperationalError:
        return ""
    finally:
        conn.close()

    if not rows:
        return ""

    rows = sorted(rows, key=lambda r: r["day"])
    lines = ["RECENT COACHING HISTORY (most recent last):"]
    for row in rows:
        user_text = (row["user_excerpt"] or "").replace("\n", " ").strip()
        coach_text = (row["assistant_excerpt"] or "").replace("\n", " ").strip()
        if len(coach_text) > MEMORY_PREVIEW_CHARS:
            coach_text = coach_text[: MEMORY_PREVIEW_CHARS - 1].rstrip() + "…"
        rating_marker = ""
        if row["rating"] and row["rating"] > 0:
            rating_marker = " [user found helpful]"
        lines.append(
            f"  [{row['day']} · {row['mode']}{rating_marker}] "
            f"player: {user_text} | coach: {coach_text}"
        )
    lines.append(
        "Use this history to keep advice consistent. "
        "Reference prior topics naturally; do not invent details that aren't there."
    )
    return "\n".join(lines)


def build_coach_system_prompt(context: str, mode: str | None = None) -> str:
    mode_key = normalize_coach_mode(mode)
    policy = COACH_MODE_POLICIES[mode_key]
    memory_block = build_coach_memory_preamble()
    memory_section = f"\n\n{memory_block}" if memory_block else ""
    return f"""You are a personalized chess improvement coach for a self-hosted chess analytics app.

Use only the supplied player context and the user's question. If the data is insufficient, say what is missing.
Do not invent game details, ratings, openings, or tactics.
Prefer concrete chess actions over motivational advice.
Never ask the user to buy anything.

COACH MODE: {policy['label']}
RESPONSE POLICY:
{policy['template']}

QUALITY GUARDRAILS:
- Include at least one specific action the user can do today.
- Tie advice to a mistake subtype, phase, opening, or drill result when available.
- Keep variations short; use SAN/UCI only when present in context.
- End with one measurable next-step.

PLAYER CONTEXT:
{context}{memory_section}""".strip()


def coach_mode_num_predict(mode: str | None = None) -> int:
    return int(COACH_MODE_POLICIES[normalize_coach_mode(mode)]["num_predict"])


def _recurring_motifs(limit: int = 4) -> list[dict]:
    """
    Fetch the latest mistake_motifs snapshot. Returns top-N by occurrence so
    the coach can reference patterns the player has actually repeated.
    """
    try:
        from api.services.mistake_motifs import get_latest_motifs

        return get_latest_motifs(limit=limit)
    except Exception:
        return []


def _repertoire_context(conn: sqlite3.Connection) -> dict:
    try:
        lines = conn.execute(
            """
            SELECT id, color, eco, name, priority,
                   (SELECT MAX(trained_at)
                    FROM opening_training_history h WHERE h.line_id = l.id) AS last_trained
            FROM repertoire_lines l
            WHERE active = 1
            ORDER BY priority DESC, COALESCE(last_trained, '0') DESC
            LIMIT 6
            """
        ).fetchall()
    except sqlite3.OperationalError:
        return {"available": False}

    missed_nodes = []
    try:
        missed_rows = conn.execute(
            """
            SELECT srs.node_id, srs.repetitions, srs.last_reviewed,
                   n.move_san, n.ply, l.name AS line_name, l.color, l.eco
            FROM repertoire_node_srs srs
            JOIN repertoire_nodes n ON n.id = srs.node_id
            JOIN repertoire_lines l ON l.id = n.line_id
            WHERE srs.last_result = 'missed' AND l.active = 1
            ORDER BY srs.last_reviewed DESC
            LIMIT 4
            """
        ).fetchall()
        missed_nodes = [dict(r) for r in missed_rows]
    except sqlite3.OperationalError:
        pass

    return {
        "available": bool(lines) or bool(missed_nodes),
        "lines": [dict(r) for r in lines],
        "missed_nodes": missed_nodes,
    }


def _time_pressure_stats(conn: sqlite3.Connection) -> dict:
    """
    Return blunder rate when the player had <60s on the clock vs >=60s.
    Uses analyzed games only.
    """
    try:
        stats = conn.execute(
            """
            SELECT
              SUM(CASE WHEN clock_before IS NOT NULL AND clock_before < 60 THEN 1 ELSE 0 END) AS pressure_moves,
              SUM(CASE WHEN clock_before IS NOT NULL AND clock_before < 60
                       AND classification IN ('mistake','blunder') THEN 1 ELSE 0 END) AS pressure_blunders,
              SUM(CASE WHEN clock_before IS NOT NULL AND clock_before >= 60 THEN 1 ELSE 0 END) AS calm_moves,
              SUM(CASE WHEN clock_before IS NOT NULL AND clock_before >= 60
                       AND classification IN ('mistake','blunder') THEN 1 ELSE 0 END) AS calm_blunders
            FROM moves
            WHERE color = (SELECT g.color FROM games g WHERE g.id = moves.game_id)
            """
        ).fetchone()
    except sqlite3.OperationalError:
        return {"available": False}

    if not stats:
        return {"available": False}

    pressure_moves = (stats["pressure_moves"] or 0)
    calm_moves = (stats["calm_moves"] or 0)
    if pressure_moves == 0 and calm_moves == 0:
        return {"available": False}

    pressure_rate = (
        (stats["pressure_blunders"] or 0) / pressure_moves if pressure_moves else None
    )
    calm_rate = (stats["calm_blunders"] or 0) / calm_moves if calm_moves else None
    multiplier = None
    if pressure_rate is not None and calm_rate and calm_rate > 0:
        multiplier = pressure_rate / calm_rate

    return {
        "available": True,
        "pressure_moves": pressure_moves,
        "pressure_blunders": stats["pressure_blunders"] or 0,
        "pressure_rate": pressure_rate,
        "calm_moves": calm_moves,
        "calm_blunders": stats["calm_blunders"] or 0,
        "calm_rate": calm_rate,
        "multiplier": multiplier,
    }


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

    pressure = _time_pressure_stats(conn)
    repertoire = _repertoire_context(conn)
    motifs = _recurring_motifs(limit=4)

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

    if pressure.get("available"):
        prate = pressure.get("pressure_rate") or 0
        crate = pressure.get("calm_rate") or 0
        mult = pressure.get("multiplier")
        mult_text = f" ({mult:.1f}× more often than when calm)" if mult and mult > 1.1 else ""
        lines += [
            "",
            "TIME-PRESSURE PROFILE:",
            f"  Under 60s on clock: {prate:.1%} of moves are mistakes/blunders{mult_text}",
            f"  60s+ on clock:      {crate:.1%} of moves are mistakes/blunders",
            f"  Pressure sample: {pressure['pressure_moves']} moves, calm sample: {pressure['calm_moves']} moves",
        ]

    if repertoire.get("available"):
        rep_lines = repertoire.get("lines") or []
        missed = repertoire.get("missed_nodes") or []
        lines += ["", "ACTIVE REPERTOIRE (what the player has chosen to learn):"]
        if rep_lines:
            for r in rep_lines:
                eco = r.get("eco") or "—"
                color = (r.get("color") or "").upper()[:1]
                last = r.get("last_trained") or "never trained"
                lines.append(
                    f"  [{color}] {eco} {r.get('name')} · priority {r.get('priority')} · last trained {last}"
                )
        if missed:
            lines += ["", "RECENTLY MISSED REPERTOIRE NODES (high-leverage prep targets):"]
            for n in missed:
                ply = int(n.get("ply") or 0)
                move_label = f"move {ply // 2 + 1}{'.' if ply % 2 == 0 else '...'}" if ply else "early"
                lines.append(
                    f"  [{(n.get('color') or '').upper()[:1]}] {n.get('eco') or '—'} {n.get('line_name')} — "
                    f"{move_label} {n.get('move_san') or '?'} (last reviewed {n.get('last_reviewed') or '—'})"
                )

    if motifs:
        lines += ["", "RECURRING MOTIFS (clustered from recent mistakes; >=3 occurrences):"]
        for m in motifs:
            family = m.get("opening_family") or "?"
            lines.append(
                f"  {m['subtype']} in {m['phase']} (ECO family {family}): "
                f"{m['occurrences']}× · avg eval loss {m.get('avg_eval_loss', 0)}cp · last seen {m.get('latest_date') or '—'}"
            )

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
        SELECT type, COALESCE(mistake_subtype, type) AS mistake_subtype,
               phase, played_move, best_move, eval_loss, is_critical,
               practical_impact, plan_text
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
            f"\n  {i}. {m['mistake_subtype'].replace('_', ' ').upper()} in {m['phase']}"
            f"\n     Played: {m['played_move']} | Better: {m['best_move']}"
            f"\n     Lost: {m['eval_loss']}cp | impact: {m['practical_impact'] or 'unknown'}{critical_marker}"
            f"\n     Plan: {m['plan_text'] or 'Review the best move candidate.'}"
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
