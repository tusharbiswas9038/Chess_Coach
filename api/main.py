# api/main.py
import logging
import time
import uuid
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import Response
from fastapi.middleware.cors import CORSMiddleware
from starlette.middleware.trustedhost import TrustedHostMiddleware

from api.db import db_conn
from api.db_migrations import run_pending_migrations
from api.dependencies import DRILLS_OK, COACH_OK
from api.job_queue import job_queue
from api.security import require_admin_if_configured
from fastapi.staticfiles import StaticFiles
from fastapi.responses import HTMLResponse, JSONResponse
import config

app = FastAPI(
    title="Chess Coach",
    version="1.0.0",
    docs_url=None if config.is_production() else "/docs",
    redoc_url=None if config.is_production() else "/redoc",
    openapi_url=None if config.is_production() else "/openapi.json",
)
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)

@app.on_event("startup")
async def startup_event():
    config.validate_startup_config()
    applied = run_pending_migrations()
    log.info(
        "startup env=%s queue_max=%s debug_routes=%s migrations_applied=%s",
        config.APP_ENV,
        config.JOB_QUEUE_MAX_SIZE,
        config.ENABLE_DEBUG_ROUTES,
        applied,
    )
    job_queue.start_worker()

@app.on_event("shutdown")
async def shutdown_event():
    log.info("shutdown initiated")
    job_queue.stop_worker()

app.add_middleware(
    CORSMiddleware,
    allow_origins=config.get_cors_origins(),
    allow_credentials=False,
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["Content-Type", "X-ADMIN-TOKEN", "Authorization"],
)

app.add_middleware(
    TrustedHostMiddleware,
    allowed_hosts=config.get_allowed_hosts(),
)


app.mount("/static", StaticFiles(directory="frontend"), name="static")

log = logging.getLogger("chess_coach.api")


@app.middleware("http")
async def add_security_headers(request: Request, call_next):
    request_id = request.headers.get("X-Request-ID") or str(uuid.uuid4())
    started = time.perf_counter()

    content_length = request.headers.get("content-length")
    if content_length:
        try:
            if int(content_length) > config.MAX_REQUEST_BODY_BYTES:
                return JSONResponse(
                    status_code=413,
                    content={"detail": "Request body too large"},
                )
        except ValueError:
            return JSONResponse(
                status_code=400,
                content={"detail": "Invalid Content-Length header"},
            )

    response: Response = await call_next(request)
    elapsed_ms = (time.perf_counter() - started) * 1000.0
    response.headers["X-Request-ID"] = request_id
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["X-Frame-Options"] = "DENY"
    response.headers["Referrer-Policy"] = "no-referrer"
    response.headers["Content-Security-Policy"] = config.get_csp_header()
    if config.is_production():
        response.headers["Strict-Transport-Security"] = "max-age=31536000; includeSubDomains"
    log.info(
        "request_id=%s method=%s path=%s status=%s duration_ms=%.1f",
        request_id,
        request.method,
        request.url.path,
        response.status_code,
        elapsed_ms,
    )
    return response

def _serve_index() -> HTMLResponse:
    with open("frontend/index.html", "r") as f:
        return HTMLResponse(content=f.read())

@app.get("/", include_in_schema=False)
async def serve_dashboard():
    return _serve_index()

@app.get("/dashboard", include_in_schema=False)
@app.get("/games", include_in_schema=False)
@app.get("/game-detail", include_in_schema=False)
@app.get("/mistakes", include_in_schema=False)
@app.get("/openings", include_in_schema=False)
@app.get("/drills", include_in_schema=False)
@app.get("/coach", include_in_schema=False)
async def serve_spa_routes():
    return _serve_index()


# ── HEALTH ────────────────────────────────────────────────────────

@app.get("/api/health") # Public health check, no API key required
def health():
    try:
        with db_conn() as conn:
            conn.execute("SELECT 1")
    except Exception as e:
        raise HTTPException(500, f"DB error: {e}")
    return {
        "ok": True,
        "drills": DRILLS_OK,
        "coach": COACH_OK,
    }


@app.get("/api/ready")
def ready(request: Request):
    require_admin_if_configured(request)
    try:
        with db_conn() as conn:
            conn.execute("SELECT 1")
    except Exception as e:
        raise HTTPException(503, f"DB unavailable: {e}")

    worker_alive = job_queue.is_worker_running()
    if not worker_alive:
        raise HTTPException(503, "Job queue worker not running")

    return {
        "ok": True,
        "db": "ok",
        "job_queue": job_queue.get_current_job_status(),
    }


@app.get("/api/metrics")
def metrics(request: Request):
    require_admin_if_configured(request)
    db_ok = 1
    try:
        with db_conn() as conn:
            conn.execute("SELECT 1")
    except Exception:
        db_ok = 0

    status = job_queue.get_current_job_status()
    queue_size = int(status.get("queue_size", 0))
    queue_max = int(status.get("queue_max_size", 0))
    worker_running = 1 if status.get("worker_running") else 0
    recent_jobs = status.get("recent_jobs", [])
    failed_recent = sum(1 for j in recent_jobs if j.get("status") == "failed")

    return {
        "db_ok": db_ok,
        "job_queue_size": queue_size,
        "job_queue_max_size": queue_max,
        "job_queue_worker_running": worker_running,
        "job_recent_failed": failed_recent,
        "env": config.APP_ENV,
    }

from api.routers.sessions import router as sessions_router
app.include_router(sessions_router, prefix="/api/sessions")

from api.routers.games import router as games_router
app.include_router(games_router, prefix="/api/games")


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

from api.routers.product import router as product_router
app.include_router(product_router)


# ── DEBUG ─────────────────────────────────────────────────────────
from api.routers.debug import router as debug_router
app.include_router(debug_router)
