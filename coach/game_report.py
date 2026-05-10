# coach/game_report.py
from __future__ import annotations
import asyncio
import sys
import threading
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1])) # Moved to top

from api.db import db_conn
from coach.prompt_builder import build_game_coaching_prompt, build_critical_move_note_prompt
from coach.ollama_client import generate


def _run_async(coro):
    try:
        asyncio.get_running_loop()
    except RuntimeError:
        return asyncio.run(coro)
    # Fallback if called from a context that already has a loop.
    holder = {"result": None, "error": None}

    def _target():
        try:
            holder["result"] = asyncio.run(coro)
        except Exception as exc:
            holder["error"] = exc

    t = threading.Thread(target=_target, daemon=True)
    t.start()
    t.join()
    if holder["error"] is not None:
        raise holder["error"]
    return holder["result"]


async def _generate_report_content(
    summary_prompt: str,
    critical_fen: str | None,
    critical_played_move: str | None,
    critical_best_move: str | None,
) -> tuple[str, str | None]:
    summary_md = await generate(summary_prompt, fast=True)
    coach_note = None
    if critical_fen and critical_played_move and critical_best_move:
        note_prompt = build_critical_move_note_prompt(
            critical_fen, critical_played_move, critical_best_move
        )
        if note_prompt:
            coach_note = await generate(note_prompt, fast=True)
    return summary_md, coach_note


def generate_and_store_report(game_id: str) -> str:
    """
    Generate a coaching note for one game using the fast model.
    Stores result in journal_entries. Returns the generated text.
    """
    with db_conn() as conn:
        # 1. Get critical mistake info
        critical_mistake = conn.execute("""
            SELECT fen, played_move, best_move FROM mistakes
            WHERE game_id=? AND is_critical=1 LIMIT 1
        """, (game_id,)).fetchone()
        
        critical_fen = critical_mistake["fen"] if critical_mistake else None
        critical_played_move = critical_mistake["played_move"] if critical_mistake else None
        critical_best_move = critical_mistake["best_move"] if critical_mistake else None

        # 2. Build game summary prompt and generate
        summary_prompt = build_game_coaching_prompt(game_id)
        if not summary_prompt:
            raise ValueError(f"Could not build summary prompt for game {game_id}")
        summary_md, coach_note = _run_async(
            _generate_report_content(
                summary_prompt,
                critical_fen,
                critical_played_move,
                critical_best_move,
            )
        )

        # 4. Store everything
        conn.execute("""
            INSERT INTO journal_entries (game_id, summary_md, coach_note, critical_fen, critical_move)
            VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(game_id) DO UPDATE SET
                summary_md = excluded.summary_md,
                coach_note = excluded.coach_note,
                critical_fen = excluded.critical_fen,
                critical_move = excluded.critical_move
        """, (game_id, summary_md, coach_note, critical_fen, critical_best_move))
        conn.commit()

    return summary_md


if __name__ == "__main__":
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))


if __name__ == "__main__":
    with db_conn() as conn:
        row = conn.execute(
            "SELECT id FROM games WHERE analyzed=1 ORDER BY date DESC LIMIT 1"
        ).fetchone()

    if row:
        print(f"Testing report for game: {row[0]}")
        result = generate_and_store_report(row[0])
        print("\n--- COACHING NOTE ---")
        print(result)
    else:
        print("No analyzed games found.")
