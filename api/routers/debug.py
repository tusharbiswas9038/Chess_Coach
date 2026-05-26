from fastapi import APIRouter, Depends
import config
from api.dependencies import get_game_repo, require_admin
from api.repositories.game_repository import GameRepository
from api.security import get_rate_limit_status, clear_rate_limit_events

router = APIRouter(prefix="/api", tags=["debug"])

if config.ENABLE_DEBUG_ROUTES:
    @router.get("/debug/db")
    def debug_db(
        repo: GameRepository = Depends(get_game_repo),
        _admin: None = Depends(require_admin),
    ):
        counts = repo.get_tables_and_counts()
        return {"tables": counts}

    @router.get("/debug/rate-limits")
    def debug_rate_limits(
        key_prefix: str | None = None,
        limit: int = 100,
        _admin: None = Depends(require_admin),
    ):
        return get_rate_limit_status(key_prefix=key_prefix, limit=limit)

    @router.post("/debug/rate-limits/clear")
    def debug_clear_rate_limits(
        key_prefix: str | None = None,
        _admin: None = Depends(require_admin),
    ):
        return clear_rate_limit_events(key_prefix=key_prefix)
