# coach/game_report.py
from __future__ import annotations
import sys
from pathlib import Path

if __name__ == "__main__":
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import sqlite3
from config import DB_PATH
from coach.prompt_builder import build_game_coaching_prompt
from coach.ollama_client import generate


def generate_and_store_report(game_id: str) -> str:
    """
    Generate a coaching note for one game using the fast model.
    Stores result in journal_entries. Returns the generated text.
    """
    prompt = build_game_coaching_prompt(game_id)
    if not prompt:
        raise ValueError(f"Could not build prompt for game {game_id}")

    report = generate(prompt, fast=True)

    conn = sqlite3.connect(DB_PATH)
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("""
        INSERT INTO journal_entries (game_id, summary_md, coach_note)
        VALUES (?, ?, ?)
        ON CONFLICT(game_id) DO UPDATE SET
            summary_md = excluded.summary_md,
            coach_note = excluded.coach_note
    """, (game_id, report, report))
    conn.commit()
    conn.close()

    return report


if __name__ == "__main__":
    conn = sqlite3.connect(DB_PATH)
    row = conn.execute(
        "SELECT id FROM games WHERE analyzed=1 ORDER BY date DESC LIMIT 1"
    ).fetchone()
    conn.close()

    if row:
        print(f"Testing report for game: {row[0]}")
        result = generate_and_store_report(row[0])
        print("\n--- COACHING NOTE ---")
        print(result)
    else:
        print("No analyzed games found.")
