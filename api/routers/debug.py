from fastapi import APIRouter, Depends, Request
import config
from api.dependencies import get_game_repo # New: import from dependencies
from api.repositories.game_repository import GameRepository
from api.security import require_admin_if_configured

router = APIRouter(prefix="/api", tags=["debug"])

if config.ENABLE_DEBUG_ROUTES:
    @router.get("/debug/db")
    def debug_db(request: Request, repo: GameRepository = Depends(get_game_repo)):
        require_admin_if_configured(request)
        counts = repo.get_tables_and_counts()
        return {"tables": counts}
