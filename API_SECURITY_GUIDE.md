# API and Security Guide

This document explains how the current FastAPI backend is organized, how API security works, and what future contributors must do when adding endpoints.

## 1. Backend Entry Points

| Area | File | Responsibility |
| --- | --- | --- |
| App setup | `api/main.py` | Creates the FastAPI app, mounts frontend static files, registers routers, adds CORS, trusted-host, request-size, logging, and security headers. |
| Runtime config | `config.py` | Reads `.env`, validates production settings, defines CORS origins, allowed hosts, CSP, queue/request limits, and rate-limit backend. |
| Security helpers | `api/security.py` | Admin-token check, rate limiting, SQLite-backed rate-limit events, debug helpers for rate-limit inspection/clearing. |
| Shared dependencies | `api/dependencies.py` | FastAPI dependencies for `GameRepository`, `require_admin`, and `rate_limit(...)`. |
| Job queue | `api/job_queue.py`, `api/jobs_service.py` | Background queue and enqueue helpers for sync, analysis, reports, sessions, player model, and maintenance. |

## 2. API Router Map

| Router | Prefix | Main use |
| --- | --- | --- |
| `api/routers/games.py` | `/api/games` | Read games, game detail, critical mistakes. |
| `api/routers/stats.py` | `/api` | Dashboard stats, bootstrap, mistake analytics, heatmap, cache clearing. |
| `api/routers/openings.py` | `/api/openings` | Opening summaries and opening genome data. |
| `api/routers/jobs.py` | `/api/jobs` | Starts sync, analysis, journal, session, player-model, weekly-report, and DB-maintenance jobs. |
| `api/routers/sessions.py` | `/api/sessions` | Session reads and session compute job. |
| `api/routers/drills.py` | `/api/drills` | Due drills, drill result submission, populate SRS from mistakes. |
| `api/routers/coach.py` | `/api/coach` | AI coach chat, game coaching generation, batch report generation. |
| `api/routers/reports.py` | `/api/reports` | Weekly report generation. |
| `api/routers/product.py` | `/api/product` | Weekly focus and latest player-model snapshot. |
| `api/routers/debug.py` | `/api/debug/*` | Debug DB/rate-limit inspection when `ENABLE_DEBUG_ROUTES=true`. |

The SPA is served from `frontend/index.html` by `api/main.py` for `/`, `/dashboard`, `/games`, `/game-detail`, `/mistakes`, `/openings`, `/drills`, and `/coach`.

## 3. Security Model

This is a self-hosted, single-user-first app. It does not currently have user accounts or browser login sessions.

Security relies on:

- Network boundary: run behind HTTPS/reverse proxy in production.
- Admin token: protected endpoints require `X-ADMIN-TOKEN` when `ADMIN_TOKEN` is configured.
- Rate limits: expensive and mutating endpoints are bucket-limited by client IP.
- CORS allowlist: only configured origins can call the API from browsers.
- Trusted host allowlist: only configured hostnames are accepted.
- CSP/security headers: responses include CSP, frame denial, MIME sniff protection, referrer policy, and HSTS in production.
- Request body size limit: large requests are rejected before route handling.

### Production Required Settings

Set these in `.env` before running with `APP_ENV=production`:

```env
APP_ENV=production
APP_SECRET_KEY=<long-random-secret-24+-chars>
ADMIN_TOKEN=<long-random-token-24+-chars>
ALLOWED_HOSTS=your.domain.example
CORS_ORIGINS=https://your.domain.example
ENABLE_DEBUG_ROUTES=false
RATE_LIMIT_BACKEND=sqlite
```

Use `openssl rand -hex 32` to generate `APP_SECRET_KEY` and `ADMIN_TOKEN`.

## 4. Admin Protection Rules

`ADMIN_TOKEN` is optional in development and required in production. When set, protected endpoints must receive:

```http
X-ADMIN-TOKEN: <ADMIN_TOKEN>
```

Current protected endpoint categories:

- Job submission: `/api/jobs/*` write endpoints.
- Job status: `/api/jobs/status`.
- Session compute: `/api/sessions/compute`.
- Report generation: `/api/reports/weekly`.
- Drill mutation: `/api/drills/result`, `/api/drills/populate`.
- Stats cache mutation: `/api/stats/clear_cache`.
- Coach AI endpoints: `/api/coach/game/{game_id}`, `/api/coach/chat`, `/api/coach/batch`.
- Operational endpoints: `/api/ready`, `/api/metrics`.
- Debug endpoints: `/api/debug/*` when enabled.

Important: the current vanilla JS frontend does not implement a login/session flow. If `ADMIN_TOKEN` is set and the browser calls protected endpoints directly, those calls need a trusted reverse proxy to inject `X-ADMIN-TOKEN`, or a future first-party auth/session implementation.

## 5. Rate Limiting

Rate limiting lives in `api/security.py`.

Use the dependency wrapper from `api/dependencies.py`:

```python
from fastapi import Depends
from api.dependencies import rate_limit

def endpoint(_rl: None = Depends(rate_limit("bucket-name", 60, 60))):
    ...
```

Backends:

- `RATE_LIMIT_BACKEND=sqlite`: stores events in `rate_limit_events` inside `data/chess.db`; survives process restarts.
- `RATE_LIMIT_BACKEND=memory`: per-process in-memory deque; simpler but not durable.

Current common buckets:

- `jobs-write`: job enqueue endpoints, 10/minute.
- `jobs-read`: job status, 120/minute.
- `coach-chat`: coach chat, 30/minute.
- `coach-game`: game coaching generation, 10/minute.
- `coach-batch`: batch coach reports, 5/minute.
- `stats-read`: analytics reads, 120/minute.
- `stats-write`: cache clearing, 10/minute.
- `drills-read`: due drills, 120/minute.
- `drills-write`: drill mutation, 10-60/minute depending on endpoint.
- `reports-write`: weekly report generation, 5/minute.

## 6. CORS, Hosts, and CSP

Configuration is in `config.py`.

- `CORS_ORIGINS` controls browser origins that can access the API.
- `ALLOWED_HOSTS` controls accepted HTTP host headers.
- `get_csp_header()` defines the Content Security Policy.

Production rules:

- Use HTTPS origins only in `CORS_ORIGINS`.
- Do not use wildcard CORS for this app.
- Keep `allow_credentials=False` unless a real browser session/auth design is added.
- If adding a new CDN/script/font/image domain, update CSP deliberately and document why.

## 7. Endpoint Safety Checklist

When adding a new API endpoint, decide which category it belongs to:

| Endpoint type | Required controls |
| --- | --- |
| Public health check | Keep minimal; no secrets, no internal metrics. |
| Read-only analytics | Add `rate_limit(...)`; avoid exposing secrets or raw prompts. |
| Mutates DB/cache/jobs | Add `Depends(require_admin)` and `rate_limit(...)`. |
| Starts Stockfish/Ollama/background work | Add `Depends(require_admin)`, strict rate limit, validation, and queueing. |
| Debug/ops endpoint | Gate behind `ENABLE_DEBUG_ROUTES` and `Depends(require_admin)`. |
| File/path endpoint | Validate names, forbid traversal, avoid raw filesystem paths in responses. |

Preferred FastAPI pattern:

```python
from fastapi import APIRouter, Depends
from api.dependencies import require_admin, rate_limit

router = APIRouter(prefix="/api/example", tags=["example"])

@router.post("/run")
def run_example(
    _admin: None = Depends(require_admin),
    _rl: None = Depends(rate_limit("example-write", 10, 60)),
):
    return {"status": "queued"}
```

## 8. AI and Chess Engine Safety

Ollama and Stockfish are expensive local resources. Treat endpoints that trigger them as privileged.

Rules:

- Do not expose Ollama directly to the internet.
- Keep `OLLAMA_URL` on localhost unless there is a secured internal network.
- Queue long-running analysis/report work instead of doing it inside request handlers.
- Validate prompt/chat payload sizes with Pydantic.
- Keep rate limits low for AI generation endpoints.
- Do not store or return raw secrets, system prompts, stack traces, or local filesystem paths.

## 9. Background Jobs

Job routes live in `api/routers/jobs.py`; queue implementation lives in `api/job_queue.py`.

Current pattern:

- Request handler validates/admin-checks/rate-limits.
- Handler enqueues work through `api/jobs_service.py` or `api/services/job_enqueue_helpers.py`.
- Request returns quickly with status such as `{"status": "started"}`.
- Frontend polls `/api/jobs/status`.

Future job endpoints should follow this pattern. Do not run Stockfish/Ollama/game sync directly inside a request handler.

## 10. Operational Endpoints

- `/api/health` is public and intentionally minimal.
- `/api/ready` is admin-protected when `ADMIN_TOKEN` is configured; it checks DB and job worker readiness.
- `/api/metrics` is admin-protected when `ADMIN_TOKEN` is configured; it returns operational counters.
- `/api/debug/*` only exists when `ENABLE_DEBUG_ROUTES=true` and is admin-protected.

## 11. Frontend/API Integration Notes

The frontend is a vanilla JS SPA served by FastAPI. API contract constants and request wrappers are in the frontend JS modules.

Security implication:

- Development can run without `ADMIN_TOKEN`.
- Production requires `ADMIN_TOKEN`, so protected frontend actions need a deployment strategy:
  - reverse proxy injects `X-ADMIN-TOKEN` for trusted local/private access, or
  - add proper login/session/auth in the app before exposing it publicly.

Do not hardcode the real admin token into frontend JavaScript.

## 12. Known Security Limitations

Current limitations to keep visible:

- No multi-user authentication or authorization model.
- Admin token is header-based, not a browser session.
- SQLite rate limiting is good for self-hosted use but not a distributed multi-instance deployment.
- CSP still allows the current Chart.js CDN and configured domain; remove unused external sources if dependencies are fully local.
- `ALLOWED_HOSTS` and `CORS_ORIGINS` must be set correctly for each deployment.

## 13. Before Production Checklist

1. Set `APP_ENV=production`.
2. Generate and set strong `APP_SECRET_KEY`.
3. Generate and set strong `ADMIN_TOKEN`.
4. Set `ALLOWED_HOSTS` to exact production hostname(s).
5. Set `CORS_ORIGINS` to exact HTTPS origin(s).
6. Keep `ENABLE_DEBUG_ROUTES=false`.
7. Keep Ollama bound to localhost/private network.
8. Run behind HTTPS.
9. Confirm protected endpoints require `X-ADMIN-TOKEN`.
10. Confirm frontend protected actions work through the chosen auth/proxy strategy.
