from typing import Any
from fastapi import Depends
from api.db import db_conn
from api.repositories.game_repository import GameRepository

# --- Module Availability Flags ---
# These are detected here to avoid circular imports from api/main.py

try:
    from drills.srs_scheduler import get_due_items, record_result, populate_srs_from_mistakes
    DRILLS_OK = True
except Exception:
    DRILLS_OK = False

try:
    from coach.ollama_client import chat as ollama_chat
    from coach.game_report import generate_and_store_report as generate_game_report
    COACH_OK = True
except Exception:
    COACH_OK = False


# --- Dependency for GameRepository ---
def get_game_repo():
    with db_conn() as conn:
        yield GameRepository(conn)
