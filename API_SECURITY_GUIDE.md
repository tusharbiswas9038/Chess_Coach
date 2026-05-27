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
| Analytics snapshots | `api/services/analytics.py` | SQLite-friendly precomputed insight slices and trend deltas for dashboard/product analytics. |

## 2. API Router Map

| Router | Prefix | Main use |
| --- | --- | --- |
| `api/routers/games.py` | `/api/games` | Read games, game detail, critical mistakes. |
| `api/routers/stats.py` | `/api` | Dashboard stats, bootstrap, mistake analytics, heatmap, cache clearing. |
| `api/routers/openings.py` | `/api/openings` | Opening summaries, genome data, weak-node detection, repertoire CRUD, and opening training history. |
| `api/routers/jobs.py` | `/api/jobs` | Starts sync, analysis, journal, session, player-model, weekly-report, and DB-maintenance jobs. |
| `api/routers/sessions.py` | `/api/sessions` | Session reads and session compute job. |
| `api/routers/drills.py` | `/api/drills` | Due drills, adaptive/retry/motif queues, drill result submission, puzzle generation, puzzle-bank summary, populate SRS from mistakes. |
| `api/routers/coach.py` | `/api/coach` | Mode-aware AI coach chat, retrieval-enhanced context, game coaching generation, batch report generation. |
| `api/routers/reports.py` | `/api/reports` | Weekly report generation. |
| `api/routers/product.py` | `/api/product` | Weekly focus, latest player-model snapshot, and latest precomputed insights snapshot. |
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
- Job status: `/api/jobs/status`, `/api/jobs/ledger` (durable history, H1).
- Session compute: `/api/sessions/compute`.
- Report generation: `POST /api/reports/weekly`. Read endpoints `GET /api/reports/weekly/latest` and `GET /api/reports/weekly/{date}` (H1) are session-protected and rate-limited.
- Drill mutation: `/api/drills/result`, `/api/drills/populate`.
- Stats cache mutation: `/api/stats/clear_cache`.
- Coach AI endpoints: `/api/coach/game/{game_id}`, `/api/coach/chat`, `/api/coach/batch`, `/api/coach/feedback` (H1, thumbs rating).
- What-if Stockfish endpoint (H9–H12): `POST /api/games/whatif` is session-protected and rate-limited (`whatif` bucket, 20/min).
- Puzzle generation: `/api/drills/generate-puzzles`.
- Opening repertoire mutation: `POST/PUT/DELETE /api/openings/repertoire*`.
- Opening training mutation: `POST /api/openings/training/result`.
- Product/motifs: `/api/product/motifs/latest` (read), `/api/product/motifs/clear-labels` (admin mutation, H6).
- Operational endpoints: `/api/ready`, `/api/metrics`.
- Debug endpoints: `/api/debug/*` when enabled.

If `ADMIN_PASSWORD_HASH` is not set but `ADMIN_TOKEN` is set, login temporarily accepts the admin token as the password — **only outside production**. As of H4 (`api/auth_service.py`, `config.py`), production startup refuses to boot when `ADMIN_PASSWORD_HASH` is unset, with an actionable error pointing at the password-hash generation command. The fallback also logs a warning per use (in dev) so it's never silently relied on.

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
- `coach-feedback`: thumbs rating writes, 60/minute (H1).
- `whatif`: review-board what-if Stockfish calls, 20/minute (H9).
- `stats-read`: analytics reads, 120/minute.
- `stats-write`: cache clearing, 10/minute.
- `product-insights`: latest precomputed insights snapshot, 60/minute.
- `product-player-model`: latest player model snapshot, 60/minute.
- `product-motifs`: motif snapshot reads, 60/minute (H5).
- `product-motifs-clear`: motif label refresh, 10/minute (H6).
- `product-weekly-focus`: weekly focus + actions, 60/minute.
- `drills-read`: due drills, 120/minute.
- `drills-write`: drill mutation and puzzle generation, 5–60/minute depending on endpoint.
- `reports-write`: weekly report generation, 5/minute.
- `reports-read`: weekly report reads, 60/minute (H1).

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
- `frontend/js/modules/views/openings.js` uses opening summary/genome/repertoire/weak-node/training endpoints.
- `frontend/js/modules/views/dashboard.js` uses `/api/product/insights/latest` for precomputed trend and slice panels.

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

## 13. Opening Preparation APIs

Opening endpoints are in `api/routers/openings.py`.

| Endpoint | Method | Auth | Purpose |
| --- | --- | --- | --- |
| `/api/openings/summary?limit=500` | GET | Session required by global API auth | Returns pre-aggregated opening performance by ECO + color. |
| `/api/openings/genome?eco=B20&color=white` | GET | Session required by global API auth | Returns win-rate by ply for an ECO/color branch. |
| `/api/openings/weak-nodes?limit=12&color=white` | GET | Session required by global API auth | Returns opening nodes where win rate, eval trend, or issue rate collapses. |
| `/api/openings/repertoire` | GET | Session required by global API auth | Lists saved active repertoire lines. |
| `/api/openings/repertoire` | POST | Admin/session required | Creates a repertoire line. |
| `/api/openings/repertoire/{line_id}` | PUT | Admin/session required | Updates a repertoire line. |
| `/api/openings/repertoire/{line_id}` | DELETE | Admin/session required | Deletes a repertoire line and cascades its nodes. |
| `/api/openings/training?color=black` | GET | Session required by global API auth | Returns an opening recall queue plus weak-node focus. |
| `/api/openings/training/result` | POST | Admin/session required | Records remembered/missed/skipped recall result. |

Security notes:

- Repertoire writes are personal training data and must stay protected.
- `RepertoireLineIn` validates color, ECO length, line name, line text length, notes length, and priority range.
- Training results validate result enum and recall time bounds.
- Weak-node detection is rule-based and uses local analyzed game/move data only.
- Opening endpoints do not call Ollama directly. Future line explanations may call Ollama, but must be admin-protected and rate-limited if added.
- Repertoire data is stored in `data/chess.db`; backups now contain personal opening preparation notes.

## 14. Insights and Player Model APIs

Product analytics endpoints are in `api/routers/product.py`.

| Endpoint | Method | Auth | Purpose |
| --- | --- | --- | --- |
| `/api/product/weekly-focus` | GET | Session required by global API auth | Returns current training focus and action checklist. |
| `/api/product/player-model/latest` | GET | Session required by global API auth | Returns latest player-model snapshot, including v2 behavioral tags and stability score. |
| `/api/product/insights/latest` | GET | Session required by global API auth | Returns latest analytics snapshot with trend deltas and insight slices. |

Analytics snapshot behavior:

- `api/services/analytics.py` computes slices by color, phase, opening family, opponent rating bucket, and result.
- It computes trend deltas for 7/14/30 day windows across win rate, games, mistakes/game, and blunders/game.
- Snapshots are stored in `analytics_snapshots`, `insight_slice_stats`, and `trend_deltas`.
- Sync, analysis, and player-model jobs compute fresh analytics snapshots and clear frontend/backend analytics caches.
- If no snapshot exists, `/api/product/insights/latest` computes one on demand.

Security notes:

- These endpoints are read-only but still protected by global API auth because they expose personal performance patterns.
- These endpoints should not return raw PGNs, prompts, secrets, stack traces, or local paths.
- Analytics snapshots are derived data, but backups are still sensitive because they reveal personal weaknesses and training history.
- Do not compute expensive analytics in the browser; use precomputed backend snapshots to reduce API and frontend load.

Player model v2:

- `player_model_snapshots` now stores `behavioral_tags` and `stability_score`.
- Tags are deterministic local summaries such as tactical volatility, piece safety risk, or stable converter.
- Stability score is derived from recent sample size, solid style, and hanging-piece risk.
- No Ollama call is required for player-model v2.

## 15. Database Tables Added For Recent Features

Recent additive migrations are managed in `api/db_migrations.py`.

| Migration | Adds |
| --- | --- |
| `004_analysis_v2_fields` | `moves.analysis_depth_policy`, `moves.candidate_alternatives`, `moves.plan_text`, `moves.practical_impact`, `moves.time_pressure_flag`; `mistakes.mistake_subtype`, `mistakes.confidence`, `mistakes.practical_impact`, `mistakes.time_pressure_flag`, `mistakes.candidate_alternatives`, `mistakes.plan_text`; `idx_mistakes_subtype_phase_eval_loss`. |
| `005_create_drill_sessions` | `drill_sessions` table for server-backed daily queue persistence. |
| `006_create_coach_quality_tables` | `coach_sessions`, `coach_feedback`, `idx_coach_sessions_created_mode`. |
| `007_create_puzzle_ecosystem` | `puzzles`, `puzzle_sources`, `srs_items.puzzle_id`, puzzle/SRS indexes. |
| `008_create_opening_repertoire_tables` | `repertoire_lines`, `repertoire_nodes`, `opening_training_history`, repertoire/training indexes. |
| `009_create_analytics_snapshot_tables` | `analytics_snapshots`, `insight_slice_stats`, `trend_deltas`, analytics indexes, `player_model_snapshots.behavioral_tags`, `player_model_snapshots.stability_score`. |
| `010_create_coach_memory_and_job_ledger` (H1) | `coach_sessions.user_rating`; `job_ledger` table for durable job tracking with status/timing/error fields and indexes on `(status, enqueued_at)` and `finished_at`. |
| `011_create_repertoire_node_srs` (H2) | `repertoire_node_srs` — SM-2 schedule for opening recall results. Bridges repertoire training into the spaced-repetition queue. |
| `012_create_mistake_motifs` (H2) | `mistake_motifs` snapshot table (cluster_key, subtype, phase, opening_family, occurrences, avg_eval_loss, example fields) with indexes on `(computed_at, occurrences)` and `(cluster_key, computed_at)`. |
| `013_job_ledger_retry_columns` (H4) | `job_ledger.retry_count`, `job_ledger.max_retries`, `job_ledger.next_retry_at`. Transient failures retry per `DEFAULT_MAX_RETRIES_BY_KIND`. |
| `014_mistake_motifs_labels` (H5) | `mistake_motifs.coach_label`, `mistake_motifs.labeled_at` — LLM-generated one-line labels (sanitizer trims bullets/quotes/length). Labels carry forward on recompute when `cluster_key` matches (H6). |
| `015_create_whatif_attempts` (H10) | `whatif_attempts` — interactive Stockfish queries from review-board what-if drag (fen, attempted_uci, best_uci, eval_before/after, delta_cp, depth). Rolling 500-row cap; coach context surfaces last 5 as `RECENT WHAT-IF EXPLORATIONS`. |

Schema design notes:

- `drill_sessions.item_ids` stores the ordered daily queue as JSON so hard refresh resumes the same session.
- `puzzles.signature` dedupes by stable FEN + best move.
- `puzzle_sources` preserves which mistakes produced a puzzle.
- `srs_items` remains the scheduling authority; `puzzles` is the reusable training content layer.
- `repertoire_lines` stores personal white/black opening line sets and notes.
- `opening_training_history` stores local recall outcomes for repertoire training.
- `analytics_snapshots.payload_json` preserves the full computed snapshot, while `insight_slice_stats` and `trend_deltas` keep query-friendly materialized rows.
- `player_model_snapshots.behavioral_tags` is JSON text, not user-provided executable content.
- `job_ledger` is the durability layer for the in-process job queue. Every enqueue/start/finish writes a row; orphans (`queued`/`running` at startup) are reconciled to `failed` with `error="lost on restart"`. `retry_count`/`max_retries`/`next_retry_at` drive transient-failure retries.
- `repertoire_node_srs` runs an SM-2 schedule per repertoire node; `remembered`→quality 2, `missed`→quality 0, `skipped`→no-op. Decoupled from `srs_items` (which schedules mistake drills).
- `mistake_motifs` is a rolling snapshot — at most a few hundred rows. Each `compute_mistake_motifs()` call writes a new `computed_at` cohort and prunes older snapshots beyond the 5-snapshot retention window. `coach_label` is generated by the 7B Ollama model and sanitized before write; carries forward across recomputes when `cluster_key` matches.
- `whatif_attempts` is append-only with a per-insert rolling 500-row cap. Coach context reads the last 5; long-tail rows age out automatically.

## 16. AI and Engine Safety: What-If Endpoint

`POST /api/games/whatif` (H9) lets the user drag any move on the review board and get a Stockfish evaluation. Treated as a privileged endpoint:

- **Auth.** Session-protected via the global API auth middleware.
- **Rate limit.** `whatif` bucket, 20/minute per IP.
- **Input validation.** `WhatIfBody` (Pydantic) validates `fen` (10–120 chars), `move` (4–5 char UCI), and optional `depth` (8–22). The engine layer (`engine/eval_position.evaluate_what_if`) re-validates the FEN with `chess.Board(fen).is_valid()` and confirms the move is legal in that position before invoking Stockfish — bad input returns a 400 with a descriptive message instead of crashing the engine.
- **Timeouts.** Per-call deadline of 8 seconds. Depth clamped server-side to `[8, 22]`.
- **Engine reuse.** Module-level singleton with `threading.Lock` (H11). On `EngineTerminatedError` the engine respawns once. `atexit.register` cleans up on shutdown.
- **Cache.** LRU keyed on `(fen, uci, depth)`, capped at 256 entries. Repeated lookups return in 0ms.
- **Persistence.** Every successful call logs to `whatif_attempts` (rolling 500-row cap). Failures don't crash the request path — the persistence wrapper catches and discards.
- **Don't expose to the internet.** Stockfish is a local CPU resource; the endpoint should stay behind the same network boundary as the rest of the API.

## 17. PWA / Service Worker

The frontend is PWA-installable as of H14. Two static assets ship at root scope:

- `GET /manifest.webmanifest` (`api.main.serve_manifest`) — app metadata, two shortcuts (Drills, Coach).
- `GET /sw.js` (`api.main.serve_service_worker`) — service worker controlling all paths.

Both are served with `Cache-Control: no-cache` so updates land on the next reload. The service worker keeps three named caches (suffixed with `CACHE_VERSION`):

- `cc-shell-v1` — stale-while-revalidate for HTML/CSS/JS/view templates.
- `cc-fonts-v1` — cache-first for Manrope (`fonts.gstatic.com`).
- `cc-api-v1` — network-first with cached fallback. **Only `/api/drills/due` is cached.** All other API calls pass through; mutations are never cached.

CSP implications:

- `worker-src` falls back to `script-src 'self'`, which is sufficient — `sw.js` is same-origin.
- `manifest-src` falls back to `default-src 'self'`, also same-origin.
- No CSP changes were needed for PWA support.

If you change `frontend/sw.js`, bump `CACHE_VERSION` so the `activate` handler invalidates the old shell cache. See OPERATIONS_RUNBOOK.md §12 for the full PWA ops playbook.

## 18. Known Security Limitations

Current limitations to keep visible:

- No multi-user authentication or role model. **By design** — single-user is the project center.
- Sessions are signed cookies, not server-side revocable sessions. Rotate `APP_SECRET_KEY` to invalidate all sessions.
- SQLite rate limiting is good for self-hosted use but not a distributed multi-instance deployment.
- CSP allows the current Chart.js CDN (`cdn.jsdelivr.net`, also used for the Lit ESM bundle as of H14) and the configured production domain; remove unused external sources if dependencies become fully local.
- `ALLOWED_HOSTS` and `CORS_ORIGINS` must be set correctly for each deployment.
- Coach sessions, motif labels, and what-if attempts store prompts/replies/positions locally. Treat `data/chess.db` as sensitive because it contains personal game data, AI chat content, and exploration history.
- Puzzle/drill/whatif endpoints expose derived game positions to authenticated users. Do not make them public.
- Repertoire and insight endpoints expose personal preparation strategy and weakness patterns. Do not make them public.
- `ADMIN_TOKEN`-as-password fallback is gated to non-production (H4); production refuses to boot without `ADMIN_PASSWORD_HASH`.

## 17. Before Production Checklist

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
15. Confirm opening repertoire writes require login/session and CSRF checks pass.
16. Confirm `/api/product/insights/latest` does not expose raw PGNs, prompts, secrets, or stack traces.
17. Back up `data/chess.db`; it now contains coach sessions, generated puzzles, drill state, repertoire notes, training history, and analytics snapshots.
