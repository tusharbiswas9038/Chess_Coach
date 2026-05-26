from typing import Callable
from fastapi import Request
from api.db import db_conn
from api.repositories.game_repository import GameRepository
from api.security import enforce_rate_limit, require_admin_if_configured

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


def require_admin(request: Request) -> None:
    require_admin_if_configured(request)


def rate_limit(bucket: str, limit: int, window_sec: int) -> Callable[[Request], None]:
    def _enforce(request: Request) -> None:
        enforce_rate_limit(request, bucket=bucket, limit=limit, window_sec=window_sec)
    return _enforce
