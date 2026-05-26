from typing import Any, List, Dict, Optional
from fastapi import APIRouter, HTTPException, Depends
from pydantic import BaseModel, Field, field_validator

from api.repositories.game_repository import GameRepository
from api.dependencies import get_game_repo # New: import from dependencies

router = APIRouter(prefix="/api/openings", tags=["openings"])


class RepertoireLineIn(BaseModel):
    color: str = Field(..., description="white or black")
    eco: Optional[str] = Field(default=None, max_length=12)
    name: str = Field(..., min_length=2, max_length=120)
    line_moves: str = Field(..., min_length=2, max_length=1000)
    notes: Optional[str] = Field(default=None, max_length=2000)
    priority: int = Field(default=3, ge=1, le=5)
    active: Optional[int] = Field(default=1, ge=0, le=1)

    @field_validator("color")
    @classmethod
    def validate_color(cls, value: str) -> str:
        clean = value.lower().strip()
        if clean not in {"white", "black"}:
            raise ValueError("color must be white or black")
        return clean

    @field_validator("eco")
    @classmethod
    def normalize_eco(cls, value: Optional[str]) -> Optional[str]:
        if value is None:
            return None
        clean = value.upper().strip()
        return clean or None

    @field_validator("name", "line_moves")
    @classmethod
    def strip_required(cls, value: str) -> str:
        return value.strip()


class TrainingResultIn(BaseModel):
    line_id: Optional[int] = None
    node_id: Optional[int] = None
    result: str
    recall_ms: Optional[int] = Field(default=None, ge=0, le=3600000)
    notes: Optional[str] = Field(default=None, max_length=1000)

    @field_validator("result")
    @classmethod
    def validate_result(cls, value: str) -> str:
        clean = value.lower().strip()
        if clean not in {"remembered", "missed", "skipped"}:
            raise ValueError("result must be remembered, missed, or skipped")
        return clean


@router.get("/summary")
def openings_summary(limit: int = 300, repo: GameRepository = Depends(get_game_repo)):
    """
    Pre-aggregated opening performance summary by ECO + color.
    Used by frontend openings view to avoid client-side full-game aggregation.
    """
    rows = repo.get_openings_summary(limit=limit)
    return rows


@router.get("/genome")
def opening_genome(eco: str, color: str, repo: GameRepository = Depends(get_game_repo)):
    """
    For a given ECO code, show win rate at each move depth.
    Tells you exactly where in the opening you start losing ground.
    """
    color = color.lower().strip()
    if color not in {"white", "black"}:
        raise HTTPException(400, "Invalid color; expected 'white' or 'black'")

    data = repo.get_opening_genome_data(eco, color)
    total_games = data["total_games"]
    ply_rows = data["ply_rows"]

    if not total_games:
        raise HTTPException(404, "No games found for this opening")

    return {
        "eco": eco,
        "color": color,
        "total_games": total_games,
        "winrate_by_ply": {
            str(r["ply"]): {
                "total": r["total"],
                "wins": r["wins"] or 0,
                "win_pct": round((r["wins"] or 0) / r["total"] * 100, 1) if r["total"] else 0,
            }
            for r in ply_rows
        }
    }


@router.get("/weak-nodes")
def opening_weak_nodes(
    limit: int = 12,
    color: Optional[str] = None,
    repo: GameRepository = Depends(get_game_repo),
):
    clean_color = color.lower().strip() if color else None
    if clean_color and clean_color not in {"white", "black"}:
        raise HTTPException(400, "Invalid color; expected 'white' or 'black'")
    return repo.get_opening_weak_nodes(limit=limit, color=clean_color)


@router.get("/repertoire")
def repertoire_lines(
    color: Optional[str] = None,
    active_only: bool = True,
    repo: GameRepository = Depends(get_game_repo),
):
    clean_color = color.lower().strip() if color else None
    if clean_color and clean_color not in {"white", "black"}:
        raise HTTPException(400, "Invalid color; expected 'white' or 'black'")
    return repo.get_repertoire_lines(color=clean_color, active_only=active_only)


@router.post("/repertoire")
def create_repertoire_line(payload: RepertoireLineIn, repo: GameRepository = Depends(get_game_repo)):
    return repo.create_repertoire_line(payload.model_dump(exclude_none=True))


@router.put("/repertoire/{line_id}")
def update_repertoire_line(
    line_id: int,
    payload: RepertoireLineIn,
    repo: GameRepository = Depends(get_game_repo),
):
    updated = repo.update_repertoire_line(line_id, payload.model_dump(exclude_none=True))
    if not updated:
        raise HTTPException(404, "Repertoire line not found")
    return updated


@router.delete("/repertoire/{line_id}")
def delete_repertoire_line(line_id: int, repo: GameRepository = Depends(get_game_repo)):
    if not repo.delete_repertoire_line(line_id):
        raise HTTPException(404, "Repertoire line not found")
    return {"ok": True, "id": line_id}


@router.get("/training")
def opening_training(
    color: Optional[str] = None,
    limit: int = 8,
    repo: GameRepository = Depends(get_game_repo),
):
    clean_color = color.lower().strip() if color else None
    if clean_color and clean_color not in {"white", "black"}:
        raise HTTPException(400, "Invalid color; expected 'white' or 'black'")
    return repo.get_opening_training_queue(color=clean_color, limit=limit)


@router.post("/training/result")
def record_opening_training(payload: TrainingResultIn, repo: GameRepository = Depends(get_game_repo)):
    return repo.record_opening_training(payload.model_dump(exclude_none=True))
