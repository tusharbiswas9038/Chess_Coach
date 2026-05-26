# API and Security Guide

This document explains how the current FastAPI backend is organized, how API security works, and what future contributors must do when adding endpoints.

## 1. Backend Entry Points

| Area | File | Responsibility |
| --- | --- | --- |
| App setup | `api/main.py` | Creates the FastAPI app, mounts frontend static files, registers routers, adds CORS, trusted-host, request-size, logging, and security headers. |
| Runtime config | `config.py` | Reads `.env`, validates production settings, defines CORS origins, allowed hosts, CSP, queue/request limits, and rate-limit backend. |
| Session auth | `api/auth_service.py`, `api/routers/auth.py` | First-party login, signed HTTP-only cookie sessions, password-hash verification, auth status endpoints. |
| Security helpers | `api/security.py` | Session/admin-token check, rate limiting, SQLite-backed rate-limit events, debug helpers for rate-limit inspection/clearing. |
| Shared dependencies | `api/dependencies.py` | FastAPI dependencies for `GameRepository`, `require_admin`, and `rate_limit(...)`. |
| Job queue | `api/job_queue.py`, `api/jobs_service.py`, `api/services/job_enqueue_helpers.py` | Background queue and enqueue helpers for sync, analysis, reports, sessions, player model, puzzle generation, and maintenance. |
| Coach context | `api/services/coach_context.py`, `coach/prompt_builder.py` | Retrieval-enhanced coaching context, coach mode prompt policies, and response guardrails. |
| Drill/puzzle engine | `drills/srs_scheduler.py` | SRS scheduling, daily drill sessions, adaptive queues, puzzle generation from mistakes, and drill summaries. |

## 2. API Router Map

| Router | Prefix | Main use |
| --- | --- | --- |
| `api/routers/games.py` | `/api/games` | Read games, game detail, critical mistakes. |
| `api/routers/stats.py` | `/api` | Dashboard stats, bootstrap, mistake analytics, heatmap, cache clearing. |
| `api/routers/openings.py` | `/api/openings` | Opening summaries and opening genome data. |
| `api/routers/jobs.py` | `/api/jobs` | Starts sync, analysis, journal, session, player-model, weekly-report, and DB-maintenance jobs. |
| `api/routers/sessions.py` | `/api/sessions` | Session reads and session compute job. |
| `api/routers/drills.py` | `/api/drills` | Due drills, adaptive/retry/motif queues, drill result submission, puzzle generation, puzzle-bank summary, populate SRS from mistakes. |
| `api/routers/coach.py` | `/api/coach` | Mode-aware AI coach chat, retrieval-enhanced context, game coaching generation, batch report generation. |
| `api/routers/reports.py` | `/api/reports` | Weekly report generation. |
| `api/routers/product.py` | `/api/product` | Weekly focus and latest player-model snapshot. |
| `api/routers/debug.py` | `/api/debug/*` | Debug DB/rate-limit inspection when `ENABLE_DEBUG_ROUTES=true`. |
| `api/routers/auth.py` | `/api/auth` | Login, logout, and current session status. |

The SPA is served from `frontend/index.html` by `api/main.py` for `/`, `/dashboard`, `/games`, `/game-detail`, `/mistakes`, `/openings`, `/drills`, and `/coach`.

## 3. Security Model

This is a self-hosted, single-user-first app with first-party admin login sessions. It is not a multi-user SaaS auth system.

Security relies on:

- Network boundary: run behind HTTPS/reverse proxy in production.
- First-party session: `/api/auth/login` creates a signed HTTP-only cookie session.
- Admin token fallback: protected endpoints also accept `X-ADMIN-TOKEN` when `ADMIN_TOKEN` is configured.
- Rate limits: expensive and mutating endpoints are bucket-limited by client IP.
- CORS allowlist: only configured origins can call the API from browsers.
- Trusted host allowlist: only configured hostnames are accepted.
- CSRF mitigation: unsafe methods reject unexpected browser `Origin` headers; session cookies use `SameSite=Lax`.
- CSP/security headers: responses include CSP, frame denial, MIME sniff protection, referrer policy, and HSTS in production.
- Request body size limit: large requests are rejected before route handling.

### Production Required Settings

Set these in `.env` before running with `APP_ENV=production`:

```env
APP_ENV=production
APP_SECRET_KEY=<long-random-secret-24+-chars>
ADMIN_TOKEN=<long-random-token-24+-chars>
ADMIN_USERNAME=admin
ADMIN_PASSWORD_HASH=<pbkdf2_sha256-password-hash>
SESSION_COOKIE_NAME=chess_coach_session
SESSION_TTL_SECONDS=43200
ALLOWED_HOSTS=your.domain.example
CORS_ORIGINS=https://your.domain.example
ENABLE_DEBUG_ROUTES=false
RATE_LIMIT_BACKEND=sqlite
```

Use `openssl rand -hex 32` to generate `APP_SECRET_KEY` and `ADMIN_TOKEN`.

Generate `ADMIN_PASSWORD_HASH` with:

```bash
python3 -c "from api.auth_service import create_password_hash; import getpass; print(create_password_hash(getpass.getpass('Admin password: ')))"
```

## 4. Admin Protection Rules

Protected endpoints accept either a valid first-party session cookie or the legacy admin-token header.

Session flow:

- `GET /api/auth/session` returns `{ authenticated, auth_required, username, expires_at }`.
- `POST /api/auth/login` accepts `{ username, password }`, verifies `ADMIN_PASSWORD_HASH`, and sets an HTTP-only session cookie.
- `POST /api/auth/logout` clears the session cookie.
- The frontend login overlay uses these endpoints and never stores the password or token in JavaScript.

`ADMIN_TOKEN` remains available for scripts, reverse proxies, and operational calls. When used directly, protected endpoints must receive:

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
- Puzzle generation: `/api/drills/generate-puzzles`.
- Operational endpoints: `/api/ready`, `/api/metrics`.
- Debug endpoints: `/api/debug/*` when enabled.

If `ADMIN_PASSWORD_HASH` is not set but `ADMIN_TOKEN` is set, login temporarily accepts the admin token as the password. This is only a migration fallback; production should use `ADMIN_PASSWORD_HASH`.

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
- `drills-write`: drill mutation and puzzle generation, 5-60/minute depending on endpoint.
- `reports-write`: weekly report generation, 5/minute.

## 6. CORS, Hosts, and CSP

Configuration is in `config.py`.

- `CORS_ORIGINS` controls browser origins that can access the API.
- `ALLOWED_HOSTS` controls accepted HTTP host headers.
- `get_csp_header()` defines the Content Security Policy.

Production rules:

- Use HTTPS origins only in `CORS_ORIGINS`.
- Do not use wildcard CORS for this app.
- Keep browser calls same-origin for the session flow. If the frontend and API are split across origins later, revisit CORS credentials, SameSite cookie behavior, and CSRF protections together.
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

### Coach Chat Modes

`POST /api/coach/chat` accepts:

```json
{
  "message": "What should I study today?",
  "history": [],
  "mode": "quick_answer"
}
```

Supported modes are normalized server-side in `coach/prompt_builder.py`:

| Mode | Purpose | Output policy |
| --- | --- | --- |
| `quick_answer` | Fast practical answer | Diagnosis, two actions, one next-game rule. |
| `deep_lesson` | Longer teaching answer | Why it happens, example from data, drill, checklist. |
| `pre_game_prep` | Before playing | Opening warning, tactical check, time-control plan, 3-game focus. |
| `post_loss_reset` | After losses | Reset, one lesson, one drill, stop condition. |

Coach context is assembled in `api/services/coach_context.py` from local DB data:

- latest player profile/model snapshot
- recent critical mistakes
- Phase 3 mistake subtypes and practical impact
- recurring motifs
- opening weak nodes
- drill outcomes

The prompt explicitly tells the model not to invent game details and to use only supplied context. `coach_sessions` stores user message, assistant reply, mode, and context digest for local quality review. `coach_feedback` exists for future rating/feedback collection.

## 9. Background Jobs

Job routes live in `api/routers/jobs.py`; queue implementation lives in `api/job_queue.py`.

Current pattern:

- Request handler validates/admin-checks/rate-limits.
- Handler enqueues work through `api/jobs_service.py` or `api/services/job_enqueue_helpers.py`.
- Request returns quickly with status such as `{"status": "started"}`.
- Frontend polls `/api/jobs/status`.

Current queued job prefixes include:

- `sync-*`
- `analyze-*`
- `coach-game-*`
- `coach-batch-*`
- `journals-*`
- `sessions-*`
- `player-model`
- `weekly-report`
- `db-maintenance-*`
- `puzzles-*`

Future job endpoints should follow this pattern. Do not run Stockfish/Ollama/game sync directly inside a request handler.

### Puzzle Generation Job

`POST /api/drills/generate-puzzles` is admin-protected and rate-limited. It enqueues a `puzzles-*` job that:

- reads analyzed mistakes
- dedupes positions by stable FEN signature + best move
- creates/updates `puzzles`
- links puzzle-to-mistake records in `puzzle_sources`
- links `srs_items.puzzle_id`
- invalidates analytics/dashboard/training frontend caches

The frontend Drills page waits for the `puzzles-*` job via `/api/jobs/status`, then refreshes the puzzle bank summary automatically.

## 10. Operational Endpoints

- `/api/health` is public and intentionally minimal.
- `/api/ready` is admin-protected when `ADMIN_TOKEN` is configured; it checks DB and job worker readiness.
- `/api/metrics` is admin-protected when `ADMIN_TOKEN` is configured; it returns operational counters.
- `/api/debug/*` only exists when `ENABLE_DEBUG_ROUTES=true` and is admin-protected.

## 11. Frontend/API Integration Notes

The frontend is a vanilla JS SPA served by FastAPI. API contract constants and request wrappers are in the frontend JS modules.

Session integration:

- `frontend/js/modules/auth.js` owns the login overlay and logout flow.
- `frontend/js/modules/api.js` sends same-origin cookies with API requests.
- `frontend/js/modules/contracts.js` defines `/api/auth/session`, `/api/auth/login`, and `/api/auth/logout`.
- The topbar Sign Out action is shown only when auth is required and the session is authenticated.
- `frontend/js/app.js` waits for auth initialization before loading protected data. After login it clears frontend caches and reloads the active view.
- `frontend/js/modules/jobs.js` provides `waitForJobByPrefix(...)` for job completion polling and cache invalidation events.
- `frontend/js/modules/views/drills.js` uses `/api/drills/due`, `/api/drills/summary`, `/api/drills/puzzles/summary`, and `/api/drills/generate-puzzles`.

Do not hardcode the real admin token into frontend JavaScript.

## 12. Drill and Puzzle APIs

Drill endpoints are in `api/routers/drills.py`.

| Endpoint | Method | Auth | Purpose |
| --- | --- | --- | --- |
| `/api/drills/due?limit=15&mode=adaptive` | GET | Session required by global API auth | Returns the active daily queue. Normal loads resume today’s queue. |
| `/api/drills/due?refresh=true` | GET | Session required by global API auth | Rebuilds today’s queue from due items. |
| `/api/drills/summary` | GET | Session required by global API auth | Returns due count, today’s drill progress, streak, and goal status. |
| `/api/drills/puzzles/summary` | GET | Session required by global API auth | Returns puzzle-bank totals, difficulty counts, motif options, and phase counts. |
| `/api/drills/result` | POST | Admin/session required | Records SRS result and returns updated summary. |
| `/api/drills/populate` | POST | Admin/session required | Creates SRS rows from mistakes if missing. |
| `/api/drills/generate-puzzles` | POST | Admin/session required | Queues puzzle generation from mistakes. |

Queue modes:

- `adaptive`: prioritizes recent hard/failed motifs, then overdue/harder items.
- `retry`: selects only items previously marked `fail` or `hard`.
- `motif`: filters by a selected motif from `/api/drills/puzzles/summary`.

Puzzle generation is rule-based and does not require Ollama. It depends on analyzed mistakes and Phase 3 fields when available.

## 13. Database Tables Added For Recent Features

Recent additive migrations are managed in `api/db_migrations.py`.

| Migration | Adds |
| --- | --- |
| `004_analysis_v2_fields` | `moves.analysis_depth_policy`, `moves.candidate_alternatives`, `moves.plan_text`, `moves.practical_impact`, `moves.time_pressure_flag`; `mistakes.mistake_subtype`, `mistakes.confidence`, `mistakes.practical_impact`, `mistakes.time_pressure_flag`, `mistakes.candidate_alternatives`, `mistakes.plan_text`; `idx_mistakes_subtype_phase_eval_loss`. |
| `005_create_drill_sessions` | `drill_sessions` table for server-backed daily queue persistence. |
| `006_create_coach_quality_tables` | `coach_sessions`, `coach_feedback`, `idx_coach_sessions_created_mode`. |
| `007_create_puzzle_ecosystem` | `puzzles`, `puzzle_sources`, `srs_items.puzzle_id`, puzzle/SRS indexes. |

Schema design notes:

- `drill_sessions.item_ids` stores the ordered daily queue as JSON so hard refresh resumes the same session.
- `puzzles.signature` dedupes by stable FEN + best move.
- `puzzle_sources` preserves which mistakes produced a puzzle.
- `srs_items` remains the scheduling authority; `puzzles` is the reusable training content layer.

## 14. Known Security Limitations

Current limitations to keep visible:

- No multi-user authentication or role model.
- Sessions are signed cookies, not server-side revocable sessions. Rotate `APP_SECRET_KEY` to invalidate all sessions.
- SQLite rate limiting is good for self-hosted use but not a distributed multi-instance deployment.
- CSP still allows the current Chart.js CDN and configured domain; remove unused external sources if dependencies are fully local.
- `ALLOWED_HOSTS` and `CORS_ORIGINS` must be set correctly for each deployment.
- Coach sessions store prompts/replies locally. Treat `data/chess.db` as sensitive because it contains personal game data and AI chat content.
- Puzzle/drill endpoints expose derived game mistakes to authenticated users. Do not make them public.

## 15. Before Production Checklist

1. Set `APP_ENV=production`.
2. Generate and set strong `APP_SECRET_KEY`.
3. Generate and set strong `ADMIN_TOKEN`.
4. Generate and set `ADMIN_PASSWORD_HASH`.
5. Set `ALLOWED_HOSTS` to exact production hostname(s).
6. Set `CORS_ORIGINS` to exact HTTPS origin(s).
7. Keep `ENABLE_DEBUG_ROUTES=false`.
8. Keep Ollama bound to localhost/private network.
9. Run behind HTTPS.
10. Confirm protected endpoints reject unauthenticated requests.
11. Confirm `/api/auth/login`, `/api/auth/session`, and `/api/auth/logout` work through the browser UI.
12. Confirm login reloads protected dashboard stats without manual refresh.
13. Confirm `/api/jobs/status` is protected.
14. Confirm `/api/drills/generate-puzzles` is protected and job status updates in the UI.
15. Back up `data/chess.db`; it now contains coach sessions, generated puzzles, and drill state.
