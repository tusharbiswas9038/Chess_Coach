import re
import logging
import sqlite3
from typing import Any

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field, field_validator

from api.dependencies import COACH_OK
from api.jobs_service import enqueue_coach_game_job, enqueue_coach_batch_job
from api.security import enforce_rate_limit, require_admin_if_configured
from api.services.coach_context import build_coach_context
from coach.ollama_client import chat, chat_stream
from coach.prompt_builder import normalize_coach_mode
from config import DB_PATH

router = APIRouter(prefix="/api/coach", tags=["coach"])
log = logging.getLogger("chess_coach.api.coach.router")


def normalize_chat_input(text: str) -> str:
    """
    Normalize whitespace for model consistency.
    NOTE: This is not a security boundary; validation and rate limits are the primary controls.
    """
    return re.sub(r"\s+", " ", text).strip()


@router.post("/game/{game_id}")
def generate_game_coaching(request: Request, game_id: str):
    require_admin_if_configured(request)
    enforce_rate_limit(request, bucket="coach-game", limit=10, window_sec=60)
    if not COACH_OK:
        raise HTTPException(501, "Coach module not available yet")
    try:
        enqueue_coach_game_job(game_id=game_id, logger=log)
    except RuntimeError as e:
        raise HTTPException(429, str(e))
    return {"status": "generating"}


class ChatMessage(BaseModel):
    message: str = Field(..., min_length=1, max_length=1200)
    history: list[dict[str, Any]] = Field(default_factory=list)
    mode: str = Field(default="quick_answer")

    @field_validator("mode")
    @classmethod
    def validate_mode(cls, value: str) -> str:
        return normalize_coach_mode(value)

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


def save_coach_session(mode: str, message: str, response: str, context_digest: str) -> int:
    conn = sqlite3.connect(DB_PATH)
    try:
        cursor = conn.execute(
            """
            INSERT INTO coach_sessions (mode, user_message, assistant_reply, context_digest)
            VALUES (?, ?, ?, ?)
            """,
            (mode, message, response, context_digest),
        )
        conn.commit()
        return int(cursor.lastrowid)
    finally:
        conn.close()


class CoachFeedback(BaseModel):
    session_id: int = Field(..., gt=0)
    rating: int = Field(..., ge=-1, le=1)  # -1 down, 0 neutral, 1 up


@router.post("/feedback")
def coach_feedback(request: Request, body: CoachFeedback):
    require_admin_if_configured(request)
    enforce_rate_limit(request, bucket="coach-feedback", limit=60, window_sec=60)
    conn = sqlite3.connect(DB_PATH)
    try:
        result = conn.execute(
            "UPDATE coach_sessions SET user_rating=? WHERE id=?",
            (body.rating, body.session_id),
        )
        conn.commit()
        if result.rowcount == 0:
            raise HTTPException(404, "session not found")
    finally:
        conn.close()
    return {"status": "ok", "session_id": body.session_id, "rating": body.rating}


@router.post("/chat")
async def coach_chat(request: Request, body: ChatMessage, stream: bool = False):
    require_admin_if_configured(request)
    enforce_rate_limit(request, bucket="coach-chat", limit=30, window_sec=60)
    if not COACH_OK:
        raise HTTPException(501, "Coach module not available yet")
    
    normalized_message = normalize_chat_input(body.message)
    messages = body.history + [{"role": "user", "content": normalized_message}]
    context = build_coach_context()

    if stream:
        async def generate_stream():
            async for chunk in chat_stream(
                messages,
                context=context["text"],
                mode=body.mode,
            ):
                yield chunk
        return StreamingResponse(generate_stream(), media_type="text/plain")

    reply = await chat(messages, context=context["text"], mode=body.mode)
    session_id = save_coach_session(body.mode, normalized_message, reply, context["digest"])
    return {"reply": reply, "mode": body.mode, "session_id": session_id}


@router.post("/batch")
def generate_batch_reports(request: Request, limit: int = 10):
    """Generate coaching reports for the most recent `limit` analyzed games without reports."""
    require_admin_if_configured(request)
    enforce_rate_limit(request, bucket="coach-batch", limit=5, window_sec=60)
    if not COACH_OK:
        raise HTTPException(501, "Coach module not available")
    limit = max(1, min(limit, 50))
    try:
        enqueue_coach_batch_job(limit=limit, logger=log)
    except RuntimeError as e:
        raise HTTPException(429, str(e))
    return {"status": "started", "queued": "up to " + str(limit) + " games"}
