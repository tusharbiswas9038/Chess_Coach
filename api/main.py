# api/main.py
import os
from typing import Any

from fastapi import BackgroundTasks, FastAPI, HTTPException, Depends, Security
from fastapi.middleware.cors import CORSMiddleware
from fastapi.security.api_key import APIKeyHeader
from pydantic import BaseModel, Field

from api.db import get_db, db_conn
from api.repositories.game_repository import GameRepository # New Import

from api.jobs_service import (
    enqueue_coach_batch_job,
    enqueue_coach_game_job,
    enqueue_journals_job,
)
from sync.fetch_games import sync_all
from engine.stockfish_worker import run_analysis_worker

from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse

# New: import config for API_SECRET_KEY and APP_ENV
import config


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


# New: API Key Security
API_KEY_NAME = "X-CHESS-COACH-KEY"
api_key_header = APIKeyHeader(name=API_KEY_NAME, auto_error=False)

async def get_api_key(api_key: str = Security(api_key_header)):
    if api_key == config.APP_SECRET_KEY:
        return api_key
    raise HTTPException(status_code=403, detail="Unauthorized")

# New: Dependency for GameRepository
def get_game_repo(conn: Any = Depends(db_conn)) -> GameRepository:
    return GameRepository(conn)

from api.job_queue import job_queue # New import

# New: FastAPI app initialization with API Key dependency
app = FastAPI(title="Chess Coach", version="1.0.0", dependencies=[Depends(get_api_key)])

@app.on_event("startup")
async def startup_event():
    job_queue.start_worker()

@app.on_event("shutdown")
async def shutdown_event():
    job_queue.stop_worker()

app.add_middleware(
    CORSMiddleware,
    # New: Tighten CORS to specific origins
    allow_origins=["http://localhost:8000", "http://127.0.0.1:8000"],
    allow_methods=["*"],
    allow_headers=["*"],
)


# Mount static files (no API key for frontend)
app.mount("/static", StaticFiles(directory="frontend"), name="static")

log = logging.getLogger("chess_coach.api")

# New: Public endpoint for root, doesn't require API key
@app.get("/", include_in_schema=False)
async def serve_dashboard():
    return FileResponse("frontend/index.html")


# ── HEALTH ────────────────────────────────────────────────────────

@app.get("/api/health")
def health():
    try:
        with db_conn() as conn:
            conn.execute("SELECT 1")
    except Exception as e:
        raise HTTPException(500, f"DB error: {e}")
    return {
        "ok": True,
        "drills": _DRILLS_OK,
        "coach": _COACH_OK,
    }


from api.routers.sessions import router as sessions_router
app.include_router(sessions_router)


from api.routers.openings import router as openings_router
app.include_router(openings_router)


from api.routers.reports import router as reports_router
app.include_router(reports_router)

from api.routers.jobs import router as jobs_router
app.include_router(jobs_router)


from api.routers.stats import router as stats_router
app.include_router(stats_router)

from api.routers.drills import router as drills_router
app.include_router(drills_router)

from api.routers.coach import router as coach_router
app.include_router(coach_router)


# ── DEBUG ─────────────────────────────────────────────────────────

if config.APP_ENV != "production":
    @app.get("/api/debug/db")
    def debug_db(repo: GameRepository = Depends(get_game_repo)):
        counts = repo.get_tables_and_counts()
        return {"tables": counts}

