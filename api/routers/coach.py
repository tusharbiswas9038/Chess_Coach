import re

from typing import Any, AsyncGenerator # New: Add AsyncGenerator
import logging
from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import StreamingResponse # New: Import StreamingResponse
from pydantic import BaseModel, Field, field_validator

from api.dependencies import COACH_OK # New: import from dependencies
from api.jobs_service import enqueue_coach_game_job, enqueue_coach_batch_job
from api.security import enforce_rate_limit, require_admin_if_configured
from coach.ollama_client import chat, chat_stream # Updated import

router = APIRouter(prefix="/api/coach", tags=["coach"])
log = logging.getLogger("chess_coach.api.coach.router")


def normalize_chat_input(text: str) -> str:
    """
    Normalize whitespace for model consistency.
    NOTE: This is not a security boundary; validation and rate limits are the primary controls.
    """
    return re.sub(r"\s+", " ", text).strip()


@router.post("/game/{game_id}")
def generate_game_coaching(request: Request, game_id: str): # Removed background_tasks
    require_admin_if_configured(request)
    enforce_rate_limit(request, bucket="coach-game", limit=10, window_sec=60)
    if not COACH_OK:
        raise HTTPException(501, "Coach module not available yet")
    try:
        enqueue_coach_game_job(game_id=game_id, logger=log) # Removed background_tasks
    except RuntimeError as e:
        raise HTTPException(429, str(e))
    return {"status": "generating"}


class ChatMessage(BaseModel):
    message: str = Field(..., min_length=1, max_length=1200)
    history: list[dict[str, Any]] = Field(default_factory=list)

    @field_validator("history")
    @classmethod
    def validate_history(cls, value: list[dict[str, Any]]) -> list[dict[str, Any]]:
        if len(value) > 20:
            raise ValueError("history is too long")
        for item in value:
            if not isinstance(item, dict):
                raise ValueError("history items must be objects")
            role = item.get("role")
            content = item.get("content")
            if role not in {"user", "assistant"}:
                raise ValueError("history role must be user or assistant")
            if not isinstance(content, str) or len(content) > 2000:
                raise ValueError("history content must be string up to 2000 chars")
        return value


@router.post("/chat")
async def coach_chat(request: Request, body: ChatMessage, stream: bool = False): # New: Add stream parameter
    require_admin_if_configured(request)
    enforce_rate_limit(request, bucket="coach-chat", limit=30, window_sec=60)
    if not COACH_OK:
        raise HTTPException(501, "Coach module not available yet")
    
    normalized_message = normalize_chat_input(body.message)
    messages = body.history + [{"role": "user", "content": normalized_message}]

    if stream:
        # If streaming, call chat_stream and return StreamingResponse
        async def generate_stream():
            async for chunk in chat_stream(messages): # Call chat_stream
                yield chunk
        return StreamingResponse(generate_stream(), media_type="text/plain") # Adjust media_type if needed
    else:
        # If not streaming, call chat and return full reply
        reply = await chat(messages) # Call chat (non-streaming)
        return {"reply": reply}


@router.post("/batch")
def generate_batch_reports(request: Request, limit: int = 10): # Removed background_tasks
    """Generate coaching reports for the most recent `limit` analyzed games without reports."""
    require_admin_if_configured(request)
    enforce_rate_limit(request, bucket="coach-batch", limit=5, window_sec=60)
    if not COACH_OK:
        raise HTTPException(501, "Coach module not available")
    limit = max(1, min(limit, 50))
    try:
        enqueue_coach_batch_job(limit=limit, logger=log) # Removed background_tasks
    except RuntimeError as e:
        raise HTTPException(429, str(e))
    return {"status": "started", "queued": "up to " + str(limit) + " games"}
