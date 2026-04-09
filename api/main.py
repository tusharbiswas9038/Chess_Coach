# api/main.py
from __future__ import annotations

import sqlite3
from typing import Any

from fastapi import BackgroundTasks, FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

from api.db import get_db
from sync.fetch_games import sync_all
from engine.stockfish_worker import run_analysis_worker

from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse


# Optional modules — safe to import even if not built yet
try:
    from drills.srs_scheduler import get_due_items, record_result, populate_srs_from_mistakes
    _DRILLS_OK = True
except Exception:
    _DRILLS_OK = False

try:
    from coach.ollama_client import chat as ollama_chat
    from coach.game_report import generate_and_store_report as generate_game_report
    _COACH_OK = True
except Exception as e:
    print(f"[coach] Module load failed: {e}")
    _COACH_OK = False



app = FastAPI(title="Chess Coach", version="1.0.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)



# Mount static files
app.mount("/static", StaticFiles(directory="frontend"), name="static")


def rows(cursor_result) -> list[dict[str, Any]]:
    return [dict(r) for r in cursor_result]


def row(r) -> dict[str, Any] | None:
    return dict(r) if r else None

@app.get("/")
def serve_dashboard():
    return FileResponse("frontend/index.html")

# ── HEALTH ────────────────────────────────────────────────────────

@app.get("/api/health")
def health():
    try:
        conn = get_db()
        conn.execute("SELECT 1")
        conn.close()
    except Exception as e:
        raise HTTPException(500, f"DB error: {e}")
    return {
        "ok": True,
        "drills": _DRILLS_OK,
        "coach": _COACH_OK,
    }


# ── SESSION  ──────────────────────────────────────────────────────

@app.get("/api/sessions")
def get_sessions(limit: int = 30):
    conn = get_db()
    rows = conn.execute("""
        SELECT * FROM sessions
        ORDER BY date DESC LIMIT ?
    """, (limit,)).fetchall()
    conn.close()
    return [dict(r) for r in rows]

@app.get("/api/sessions/today")
def get_today_session():
    """Returns today's session — used for tilt warning on dashboard."""
    conn = get_db()
    result = conn.execute("""
        SELECT * FROM sessions WHERE date = date('now')
    """).fetchone()
    conn.close()
    return dict(result) if result else {"games_played": 0, "tilt_detected": 0, "result_sequence": ""}

@app.post("/api/sessions/compute")
def recompute_sessions(background_tasks: BackgroundTasks):
    from classifier.session_tracker import compute_sessions
    background_tasks.add_task(compute_sessions)
    return {"status": "computing"}


# ── OPENING GENOME ────────────────────────────────────────────────

@app.get("/api/openings/genome")
def opening_genome(eco: str, color: str):
    """
    For a given ECO code, show win rate at each move depth.
    Tells you exactly where in the opening you start losing ground.
    """
    conn = get_db()

    games = conn.execute("""
        SELECT g.id, g.result
        FROM games g
        WHERE g.opening_eco=? AND g.color=? AND g.analyzed=1
    """, (eco, color)).fetchall()

    if not games:
        conn.close()
        raise HTTPException(404, "No games found for this opening")

    # For each game, get moves up to ply 20
    move_winrates = {}
    for g in games:
        moves = conn.execute("""
            SELECT ply, san, eval_delta
            FROM moves
            WHERE game_id=? AND ply <= 20
            ORDER BY ply
        """, (g["id"],)).fetchall()

        for m in moves:
            ply = m["ply"]
            if ply not in move_winrates:
                move_winrates[ply] = {"total": 0, "wins": 0}
            move_winrates[ply]["total"] += 1
            if g["result"] == "win":
                move_winrates[ply]["wins"] += 1

    conn.close()

    return {
        "eco": eco,
        "color": color,
        "total_games": len(games),
        "winrate_by_ply": {
            str(ply): {
                "total": v["total"],
                "wins": v["wins"],
                "win_pct": round(v["wins"] / v["total"] * 100, 1) if v["total"] else 0
            }
            for ply, v in sorted(move_winrates.items())
        }
    }


# ── REPORTS ───────────────────────────────────────────────────────

@app.post("/api/reports/weekly")
def generate_weekly(background_tasks: BackgroundTasks):
    if not _COACH_OK:
        raise HTTPException(501, "Coach not available")
    from reports.weekly_report import generate_weekly_report
    background_tasks.add_task(generate_weekly_report)
    return {"status": "generating"}


# ── JOBS ──────────────────────────────────────────────────────────

@app.post("/api/jobs/sync")
def job_sync(background_tasks: BackgroundTasks):
    background_tasks.add_task(sync_all, False)
    return {"status": "sync started"}

@app.post("/api/jobs/analyze")
def job_analyze(background_tasks: BackgroundTasks):
    background_tasks.add_task(run_analysis_worker)
    return {"status": "analysis started"}

@app.post("/api/jobs/journals")
def job_journals(background_tasks: BackgroundTasks, limit: int = 15):
    if not _COACH_OK:
        raise HTTPException(501, "Coach not available")
    def _run():
        import sqlite3
        from config import DB_PATH
        from coach.game_report import generate_and_store_report
        conn = sqlite3.connect(DB_PATH)
        conn.row_factory = sqlite3.Row
        games = conn.execute("""
            SELECT g.id FROM games g
            LEFT JOIN journal_entries j ON j.game_id = g.id
            WHERE g.analyzed=1 AND j.id IS NULL
            ORDER BY g.date DESC LIMIT ?
        """, (limit,)).fetchall()
        conn.close()
        for row in games:
            try:
                generate_and_store_report(row["id"])
            except Exception as e:
                print(f"Journal failed {row['id'][:16]}: {e}")
    background_tasks.add_task(_run)
    return {"status": f"generating up to {limit} journals"}

@app.post("/api/jobs/sessions")
def job_sessions(background_tasks: BackgroundTasks):
    from classifier.session_tracker import compute_sessions
    background_tasks.add_task(compute_sessions)
    return {"status": "computing sessions"}

@app.post("/api/jobs/weekly-report")
def job_weekly_report(background_tasks: BackgroundTasks):
    if not _COACH_OK:
        raise HTTPException(501, "Coach not available")
    from reports.weekly_report import generate_weekly_report
    background_tasks.add_task(generate_weekly_report)
    return {"status": "generating weekly report"}


# ── STATS / DASHBOARD ─────────────────────────────────────────────

@app.get("/api/stats")
def get_stats():
    conn = get_db()

    profile = conn.execute(
        "SELECT * FROM player_profile WHERE id=1"
    ).fetchone()

    totals = conn.execute("""
        SELECT
            COUNT(*) AS total,
            SUM(CASE WHEN analyzed=1 THEN 1 ELSE 0 END) AS analyzed,
            SUM(CASE WHEN analyzed=0 THEN 1 ELSE 0 END) AS pending,
            SUM(CASE WHEN analyzed=2 THEN 1 ELSE 0 END) AS errors
        FROM games
    """).fetchone()

    hanging_games = conn.execute(
        "SELECT COUNT(DISTINCT game_id) FROM moves WHERE is_hanging_piece=1"
    ).fetchone()[0]

    blunders = conn.execute("""
        SELECT
            COUNT(*) AS total_blunders,
            COUNT(DISTINCT game_id) AS games_with_blunders
        FROM mistakes
        WHERE type IN ('blunder','hanging_piece')
    """).fetchone()

    recent_games = conn.execute("""
        SELECT
            g.id, g.date, g.color, g.result,
            g.opponent_rating, g.analyzed,
            g.opening_eco, g.opening_name,
            COALESCE(COUNT(DISTINCT m.id), 0) AS mistake_count
        FROM games g
        LEFT JOIN mistakes m ON m.game_id = g.id
        GROUP BY g.id
        ORDER BY g.date DESC
        LIMIT 10
    """).fetchall()

    mistake_breakdown = conn.execute("""
        SELECT type, COUNT(*) AS count
        FROM mistakes
        GROUP BY type
        ORDER BY count DESC
    """).fetchall()

    weekly_stats = conn.execute("""
        SELECT
            date(date, 'weekday 1', '-7 days') AS week_start,
            COUNT(*) AS games,
            SUM(CASE WHEN result='win' THEN 1 ELSE 0 END) AS wins,
            ROUND(
                100.0 * SUM(CASE WHEN result='win' THEN 1 ELSE 0 END) / COUNT(*),
                1
            ) AS win_pct
        FROM games
        GROUP BY week_start
        ORDER BY week_start DESC
        LIMIT 8
    """).fetchall()

    drills_due = 0
    if _DRILLS_OK:
        drills_due = conn.execute(
            "SELECT COUNT(*) FROM srs_items WHERE due_date <= date('now')"
        ).fetchone()[0]

    conn.close()

    total = totals["total"] or 1  # avoid division by zero
    analyzed = totals["analyzed"] or 0

    return {
        "profile": row(profile) or {},
        "games": dict(totals),
        "hanging_piece_rate": round(hanging_games / analyzed, 4) if analyzed else 0,
        "blunders_per_game": round(blunders["total_blunders"] / analyzed, 2) if analyzed else 0,
        "recent_games": rows(recent_games),
        "mistake_breakdown": rows(mistake_breakdown),
        "weekly_stats": rows(weekly_stats),
        "drills_due": drills_due,
    }


# ── GAMES ─────────────────────────────────────────────────────────

@app.get("/api/games")
def list_games(
    limit: int = 20,
    offset: int = 0,
    search: str | None = None,
    opening: str | None = None,
    color: str | None = None,
    result: str | None = None,
    analyzed: int | None = None,
    min_mistakes: int = 0,
    has_journal: bool | None = None,
    sort: str = "date_desc",
    return_total: bool = False,
):
    limit = max(1, min(limit, 100))
    offset = max(0, offset)
    min_mistakes = max(0, min_mistakes)

    valid_colors = {"white", "black"}
    valid_results = {"win", "loss", "draw"}
    valid_sorts = {
        "date_desc": "date DESC",
        "date_asc": "date ASC",
        "mistakes_desc": "mistake_count DESC, date DESC",
        "opponent_desc": "opponent_rating DESC, date DESC",
        "opponent_asc": "opponent_rating ASC, date DESC",
    }

    if color and color not in valid_colors:
        raise HTTPException(400, "Invalid color filter")
    if result and result not in valid_results:
        raise HTTPException(400, "Invalid result filter")
    if analyzed is not None and analyzed not in {0, 1, 2}:
        raise HTTPException(400, "Invalid analyzed filter")
    if sort not in valid_sorts:
        raise HTTPException(400, "Invalid sort option")

    inner_where: list[str] = []
    inner_params: list[Any] = []
    outer_where: list[str] = []
    outer_params: list[Any] = []

    if search and (term := search.strip().lower()):
        like = f"%{term}%"
        inner_where.append("""
            (
                LOWER(COALESCE(g.opening_name, '')) LIKE ?
                OR LOWER(COALESCE(g.opening_eco, '')) LIKE ?
                OR CAST(COALESCE(g.opponent_rating, '') AS TEXT) LIKE ?
                OR LOWER(COALESCE(g.date, '')) LIKE ?
            )
        """)
        inner_params.extend([like, like, like, like])

    if opening and (term := opening.strip().lower()):
        like = f"%{term}%"
        inner_where.append("""
            (
                LOWER(COALESCE(g.opening_name, '')) LIKE ?
                OR LOWER(COALESCE(g.opening_eco, '')) LIKE ?
            )
        """)
        inner_params.extend([like, like])

    if color:
        inner_where.append("g.color = ?")
        inner_params.append(color)

    if result:
        inner_where.append("g.result = ?")
        inner_params.append(result)

    if analyzed is not None:
        inner_where.append("g.analyzed = ?")
        inner_params.append(analyzed)

    if min_mistakes > 0:
        outer_where.append("mistake_count >= ?")
        outer_params.append(min_mistakes)

    if has_journal is not None:
        outer_where.append("has_journal = ?")
        outer_params.append(1 if has_journal else 0)

    inner_clause = f"WHERE {' AND '.join(inner_where)}" if inner_where else ""
    outer_clause = f"WHERE {' AND '.join(outer_where)}" if outer_where else ""

    cte = f"""
        WITH game_rows AS (
            SELECT
                g.id, g.date, g.color, g.result,
                g.time_control, g.opponent_rating, g.analyzed,
                g.opening_eco, g.opening_name,
                COALESCE(COUNT(DISTINCT m.id), 0) AS mistake_count,
                j.coach_note,
                CASE WHEN j.id IS NULL THEN 0 ELSE 1 END AS has_journal
            FROM games g
            LEFT JOIN mistakes m ON m.game_id = g.id
            LEFT JOIN journal_entries j ON j.game_id = g.id
            {inner_clause}
            GROUP BY g.id
        )
    """

    conn = get_db()
    result = conn.execute(
        cte
        + f"""
        SELECT *
        FROM game_rows
        {outer_clause}
        ORDER BY {valid_sorts[sort]}
        LIMIT ? OFFSET ?
        """,
        (*inner_params, *outer_params, limit, offset),
    ).fetchall()

    items = rows(result)
    if not return_total:
        conn.close()
        return items

    total = conn.execute(
        cte
        + f"""
        SELECT COUNT(*) AS total
        FROM game_rows
        {outer_clause}
        """,
        (*inner_params, *outer_params),
    ).fetchone()["total"]
    conn.close()
    return {
        "items": items,
        "total": total,
        "limit": limit,
        "offset": offset,
    }


@app.get("/api/games/{game_id}")
def get_game(game_id: str):
    conn = get_db()

    try:
        game_row = conn.execute(
                "SELECT * FROM games WHERE id=?", (game_id,)
                ).fetchone()
        if not game_row:
            conn.close()
            raise HTTPException(404, "Game not found")
        moves_rows = conn.execute(
                "SELECT * FROM moves WHERE game_id=? ORDER BY ply", (game_id,)
                ).fetchall()
        mistakes_rows = conn.execute(
                "SELECT * FROM mistakes WHERE game_id=? ORDER BY is_critical DESC, eval_loss DESC",
                (game_id,)
                ).fetchall()
        journal_row = conn.execute(
                "SELECT * FROM journal_entries WHERE game_id=?", (game_id,)
                ).fetchone()
        return {
                "game": dict(game_row),
                "moves": rows(moves_rows),
                "mistakes": rows(mistakes_rows),
                "journal": row(journal_row),
                }
    finally:
        conn.close()


@app.get("/api/games/{game_id}/critical")
def get_critical_moment(game_id: str):
    """Return the single most impactful mistake in this game."""
    conn = get_db()
    result = conn.execute("""
        SELECT * FROM mistakes
        WHERE game_id=? AND is_critical=1
        LIMIT 1
    """, (game_id,)).fetchone()
    conn.close()
    return dict(result) if result else {}


# ── ANALYSIS PROGRESS ─────────────────────────────────────────────

@app.get("/api/analysis/progress")
def analysis_progress():
    conn = get_db()
    result = conn.execute("""
        SELECT
            SUM(CASE WHEN analyzed=1 THEN 1 ELSE 0 END) AS done,
            SUM(CASE WHEN analyzed=0 THEN 1 ELSE 0 END) AS pending,
            SUM(CASE WHEN analyzed=2 THEN 1 ELSE 0 END) AS errors,
            COUNT(*) AS total
        FROM games
    """).fetchone()
    conn.close()
    return dict(result)


# ── SYNC & ANALYZE ────────────────────────────────────────────────

@app.post("/api/sync")
def trigger_sync(background_tasks: BackgroundTasks, full: bool = False):
    background_tasks.add_task(sync_all, full)
    return {"status": "sync started", "full": full}


@app.post("/api/analyze")
def trigger_analysis(background_tasks: BackgroundTasks):
    background_tasks.add_task(run_analysis_worker)
    return {"status": "analysis started"}


# ── DRILLS (SRS) ──────────────────────────────────────────────────

@app.get("/api/drills/due")
def get_due_drills(limit: int = 15):
    if not _DRILLS_OK:
        raise HTTPException(501, "Drills module not available yet")
    return get_due_items(limit=max(1, min(limit, 50)))


class DrillResult(BaseModel):
    item_id: int = Field(..., ge=1)
    quality: int = Field(..., ge=0, le=3)


@app.post("/api/drills/result")
def submit_drill_result(result: DrillResult):
    if not _DRILLS_OK:
        raise HTTPException(501, "Drills module not available yet")
    record_result(result.item_id, result.quality)
    return {"status": "ok"}


@app.post("/api/drills/populate")
def populate_drills_from_mistakes():
    if not _DRILLS_OK:
        raise HTTPException(501, "Drills module not available yet")
    populate_srs_from_mistakes()
    return {"status": "ok"}

@app.get("/api/mistakes/by-phase")
def mistakes_by_phase():
    conn = get_db()
    rows = conn.execute("""
        SELECT phase, COUNT(*) AS count
        FROM mistakes
        WHERE phase IS NOT NULL
        GROUP BY phase
        ORDER BY count DESC
    """).fetchall()
    conn.close()
    return [dict(r) for r in rows]

# ── COACHING ──────────────────────────────────────────────────────

@app.post("/api/coach/game/{game_id}")
def generate_game_coaching(game_id: str, background_tasks: BackgroundTasks):
    if not _COACH_OK:
        raise HTTPException(501, "Coach module not available yet")

    def _run():
        try:
            from coach.game_report import generate_and_store_report
            report = generate_and_store_report(game_id)
            if report:
                print(f"[coach/game] ✓ {game_id[:16]}...")
            else:
                print(f"[coach/game] empty report for {game_id[:16]}...")
        except Exception as e:
            print(f"[coach/game] ✗ {game_id[:16]}...: {e}")

    background_tasks.add_task(_run)
    return {"status": "generating"}


class ChatMessage(BaseModel):
    message: str = Field(..., min_length=1)
    history: list[dict[str, Any]] = []


@app.post("/api/coach/chat")
def coach_chat(body: ChatMessage):
    if not _COACH_OK:
        raise HTTPException(501, "Coach module not available yet")
    messages = body.history + [{"role": "user", "content": body.message}]
    reply = ollama_chat(messages)
    return {"reply": reply}

@app.post("/api/coach/batch")
def generate_batch_reports(background_tasks: BackgroundTasks, limit: int = 10):
    """Generate coaching reports for the most recent `limit` analyzed games without reports."""
    if not _COACH_OK:
        raise HTTPException(501, "Coach module not available")

    def _run():
        import time
        conn = get_db()
        games = conn.execute("""
            SELECT g.id FROM games g
            LEFT JOIN journal_entries j ON j.game_id = g.id
            WHERE g.analyzed=1 AND j.id IS NULL
            ORDER BY g.date DESC
            LIMIT ?
        """, (limit,)).fetchall()
        conn.close()

        from coach.game_report import generate_and_store_report
        success = 0
        failed = 0
        batch_start = time.time()

        for row in games:
            for attempt in range(2):
                try:
                    t0 = time.time()
                    generate_and_store_report(row["id"])
                    elapsed = time.time() - t0
                    success += 1
                    print(f"  ✓ Report: {row['id'][:16]}...")
                    time.sleep(3)
                    break
                except Exception as e:
                    if attempt == 0:
                        print(f"  ↻ Retry: {row['id'][:16]}... ({e})")
                        time.sleep(10)
                    else:
                        print(f"  ✗ Failed: {row['id'][:16]}... ({e})")
                        failed += 1



        total = time.time() - batch_start
        print(f"\nBatch done: {success} ok, {failed} failed — total {total:.0f}s ({total/60:.1f}min)")
    background_tasks.add_task(_run)
    return {"status": "started", "queued": "up to " + str(limit) + " games"}

# ── DEBUG ─────────────────────────────────────────────────────────

@app.get("/api/debug/db")
def debug_db():
    conn = get_db()
    tables = conn.execute(
        "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
    ).fetchall()
    counts = {}
    for t in tables:
        name = t["name"]
        try:
            counts[name] = conn.execute(f"SELECT COUNT(*) FROM \"{name}\"").fetchone()[0]
        except Exception:
            counts[name] = None
    conn.close()
    return {"tables": counts}
