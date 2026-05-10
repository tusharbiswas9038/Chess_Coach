from typing import Any, List, Dict, Optional
from fastapi import APIRouter, HTTPException, Depends


from api.repositories.game_repository import GameRepository
from api.dependencies import get_game_repo

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
