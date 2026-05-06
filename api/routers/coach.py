from typing import Any
import logging
from fastapi import APIRouter, BackgroundTasks, HTTPException
from pydantic import BaseModel, Field

from api.main import _COACH_OK # Import global variable, consider refactoring later
from api.jobs_service import enqueue_coach_game_job, enqueue_coach_batch_job
from coach.ollama_client import chat as ollama_chat


router = APIRouter(prefix="/api/coach", tags=["coach"])
log = logging.getLogger("chess_coach.api.coach.router")


@router.post("/game/{game_id}")
def generate_game_coaching(game_id: str): # Removed background_tasks
    if not _COACH_OK:
        raise HTTPException(501, "Coach module not available yet")
    enqueue_coach_game_job(game_id=game_id, logger=log) # Removed background_tasks
    return {"status": "generating"}


class ChatMessage(BaseModel):
    message: str = Field(..., min_length=1)
    history: list[dict[str, Any]] = Field(default_factory=list)


@router.post("/chat")
async def coach_chat(body: ChatMessage):
    if not _COACH_OK:
        raise HTTPException(501, "Coach module not available yet")
    messages = body.history + [{"role": "user", "content": body.message}]
    reply = await ollama_chat(messages)
    return {"reply": reply}


@router.post("/batch")
def generate_batch_reports(limit: int = 10): # Removed background_tasks
    """Generate coaching reports for the most recent `limit` analyzed games without reports."""
    if not _COACH_OK:
        raise HTTPException(501, "Coach module not available")
    limit = max(1, min(limit, 50))
    enqueue_coach_batch_job(limit=limit, logger=log) # Removed background_tasks
    return {"status": "started", "queued": "up to " + str(limit) + " games"}
