from typing import Any, List, Dict, Optional
from fastapi import APIRouter, HTTPException, Depends, Request
from pydantic import BaseModel, Field


from api.repositories.game_repository import GameRepository
from api.dependencies import get_game_repo
from api.security import enforce_rate_limit

router = APIRouter(tags=["games"])

@router.get("")
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
    repo: GameRepository = Depends(get_game_repo),
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

    return repo.list_games(
        limit=limit,
        offset=offset,
        search=search,
        opening=opening,
        color=color,
        result=result,
        analyzed=analyzed,
        min_mistakes=min_mistakes,
        has_journal=has_journal,
        sort=sort,
        valid_sorts=valid_sorts,
        return_total=return_total,
    )

@router.get("/{game_id}")
def get_game(game_id: str, repo: GameRepository = Depends(get_game_repo)):
        game_row = repo.get_game_by_id(game_id)
        if not game_row:
            raise HTTPException(404, "Game not found")
        moves_rows = repo.get_moves_for_game(game_id)
        mistakes_rows = repo.get_mistakes_for_game(game_id)
        journal_row = repo.get_journal_entry_for_game(game_id)
        return {
            "game": game_row,
            "moves": moves_rows,
            "mistakes": mistakes_rows,
            "journal": journal_row,
        }

@router.get("/{game_id}/critical")
def get_critical_moment(game_id: str, repo: GameRepository = Depends(get_game_repo)):
    """Return the single most impactful mistake in this game."""
    result = repo.get_critical_moment_for_game(game_id)
    return result if result else {}


class WhatIfBody(BaseModel):
    fen: str = Field(..., min_length=10, max_length=120)
    move: str = Field(..., min_length=4, max_length=5)
    depth: Optional[int] = Field(default=None, ge=8, le=22)


@router.post("/whatif")
def evaluate_whatif(request: Request, body: WhatIfBody):
    """
    Stockfish-evaluate a hypothetical move from a position. Used by the
    review board's what-if drag to show the eval delta of an alternative
    move without persisting anything.
    """
    enforce_rate_limit(request, bucket="whatif", limit=20, window_sec=60)
    from engine.eval_position import evaluate_what_if, DEFAULT_WHATIF_DEPTH

    move = body.move.lower()
    depth = body.depth if body.depth is not None else DEFAULT_WHATIF_DEPTH
    result = evaluate_what_if(body.fen, move, depth=depth)
    if not result.get("ok"):
        raise HTTPException(400, result.get("error") or "Could not evaluate")

    # Log the attempt so the coach can later reference exploration history.
    # Failures here are non-fatal — what-if remains primarily interactive.
    try:
        from api.db import db_conn

        with db_conn() as conn:
            conn.execute(
                """
                INSERT INTO whatif_attempts
                    (fen, attempted_uci, best_uci, eval_before, eval_after, delta_cp, depth)
                VALUES (?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    body.fen,
                    move,
                    result.get("best_move"),
                    result.get("eval_before"),
                    result.get("eval_after"),
                    result.get("delta"),
                    result.get("depth"),
                ),
            )
            # Keep the rolling log bounded — last 500 attempts is plenty for
            # context windows; older ones get pruned each call.
            conn.execute(
                """
                DELETE FROM whatif_attempts
                WHERE id NOT IN (
                    SELECT id FROM whatif_attempts ORDER BY id DESC LIMIT 500
                )
                """
            )
            conn.commit()
    except Exception:
        # Pure logging concern — don't fail the user's interactive call.
        pass

    return result
