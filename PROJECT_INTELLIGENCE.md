# PROJECT_INTELLIGENCE

> **Last verified:** 2026-05-27 (Horizon 1 + Horizon 2 polish — coach memory, repertoire ↔ SRS bridge, opening-aware coaching, recurring motif clustering, weekly report reflection, hanging-rate bug fix).

## 1. Executive Summary
- **Product**: Self-hosted AI chess coaching platform for a single player (`CHESS_USERNAME`, default `Tushar9038`) that syncs Chess.com rapid games, analyzes them with Stockfish, extracts mistakes, generates drills, and provides AI coaching/reports.
- **Primary goals**: Convert raw game history into actionable improvement loops (analyze -> prioritize -> drill -> coach).
- **Target use case**: Personal training dashboard (not multi-tenant SaaS), desktop-first but mobile-usable.
- **Current maturity**: **Functional beta**. Core flows work end-to-end; architecture is coherent but still has notable technical debt and scaling/security limitations.

## 2. Tech Stack

| Area | Stack |
|---|---|
| Frontend | Vanilla JS (ES modules), Chart.js CDN, Tailwind CSS v4 + daisyUI |
| Backend | FastAPI 0.128.3, Starlette 0.49.1, Uvicorn |
| DB | SQLite (`data/chess.db`) with WAL, foreign keys enabled |
| Chess engine | `python-chess` + local Stockfish binary (`/usr/games/stockfish`) |
| LLM | Ollama local HTTP API (`OLLAMA_URL`), two models (`chess-coach`, `chess-coach-fast`) |
| Jobs | In-process singleton queue + worker thread (`api/job_queue.py`) |
| Runtime/config | `.env` + `config.py`, static frontend served by FastAPI |

## 3. High-Level Architecture

### Frontend architecture
- Single-page shell in [frontend/index.html](/frontend/index.html).
- App bootstrap in [frontend/js/app.js](/frontend/js/app.js) composes feature modules (`views/*`), shared helpers (`api`, `contracts`, `ui`, `charts`, `cache`, `preferences`, `jobs`).
- Hash-based route state (`#/dashboard`, etc.) via [navigation.js](/frontend/js/modules/views/navigation.js).
- API paths + response normalizers centralized in [contracts.js](/frontend/js/modules/contracts.js).

### Backend architecture
- FastAPI entrypoint in [api/main.py](/api/main.py) mounts static frontend and includes routers.
- Router layer in `api/routers/*` for endpoint grouping.
- Data access via [GameRepository](/api/repositories/game_repository.py).
- Job orchestration in [api/services/job_enqueue_helpers.py](/api/services/job_enqueue_helpers.py) + [api/job_queue.py](/api/job_queue.py).
- Background computations: sync, stockfish analysis, session aggregation, player model snapshot, weekly report, DB maintenance.

### Data + AI flow
1. `POST /api/jobs/sync` -> [sync/fetch_games.py](/sync/fetch_games.py) inserts new games.
2. `POST /api/jobs/analyze` -> [engine/stockfish_worker.py](/engine/stockfish_worker.py) analyzes pending games, writes `moves` and `mistakes`.
3. `POST /api/jobs/player-model` or post-sync/analyze hooks -> [player_model.py](/api/services/player_model.py) writes snapshots + updates `player_profile`.
4. Dashboard/stats/product APIs read aggregates from repository.
5. Coach/game reports call Ollama through [coach/ollama_client.py](/coach/ollama_client.py).

### Request lifecycle
- Security headers + CSP + request-id + body-size gate in middleware ([api/main.py](/api/main.py)).
- Optional admin token guard and in-memory rate limits ([api/security.py](/api/security.py)).
- DB opened per request via dependency/context manager (`db_conn()`).

## 4. Folder & File Breakdown

| Path | Purpose | Key relationships |
|---|---|---|
| `api/main.py` | FastAPI app, middleware, health/readiness/metrics, router registration | Uses `config`, `job_queue`, migration runner |
| `api/routers/*` | Endpoint surface by domain | Delegates to repository/services/jobs |
| `api/repositories/game_repository.py` | Core SQL query layer | Used by stats/games/openings/product/sessions |
| `api/services/job_enqueue_helpers.py` | Job wrappers + cache invalidation payloads | Enqueues sync/analyze/sessions/model/report/maintenance |
| `api/job_queue.py` | Single worker thread queue with status/recent jobs | Polled by frontend actions/jobs module |
| `api/db.py` | SQLite connection settings (WAL, busy_timeout, FK ON) | Shared by API/services/scripts |
| `api/db_migrations.py` | Runtime migrations + index reconciliation | Executed on startup |
| `sync/fetch_games.py` | Chess.com sync ingestion and upsert | Fills `games` |
| `engine/stockfish_worker.py` | Analysis pipeline, move classification, mistake extraction | Fills `moves`, `mistakes`, updates `games.analyzed` |
| `drills/srs_scheduler.py` | SM-2-like scheduling and result recording | Reads/writes `srs_items` |
| `coach/*` | Prompt/context building and Ollama integration | Reads DB context, writes journal |
| `reports/weekly_report.py` | Weekly markdown report generation with Ollama | Writes `reports/week-*.md` |
| `frontend/js/modules/views/*` | Per-page UI logic | Uses shared contracts/api/cache/jobs |
| `frontend/css/tailwind.input.css` | Token authority + primitive ownership | Builds `frontend/css/tailwind.css` |
| `frontend/css/modules/*` | Residual custom CSS (layout/features/responsive only) | Should avoid generic primitive ownership |

## 5. Frontend Analysis

### Routing/navigation/state
- Route parsing + hash sync in [navigation.js](/frontend/js/modules/views/navigation.js).
- Central mutable app state in [app.js](/frontend/js/app.js) (`statsData`, `charts`).
- View modules created with dependency injection style; each binds its own events.

### Reusable frontend primitives
- API contract/normalization: [contracts.js](/frontend/js/modules/contracts.js).
- Fetch helpers: [api.js](/frontend/js/modules/api.js).
- Shared markup helpers (state rows/badges/etc.): [ui.js](/frontend/js/modules/ui.js).
- Chart defaults + palettes: [charts.js](/frontend/js/modules/charts.js).
- Cache + invalidation hooks: [cache.js](/frontend/js/modules/cache.js), [jobs.js](/frontend/js/modules/jobs.js).

### Styling system and UX direction
- Tailwind+daisy is primary owner ([tailwind.input.css](/frontend/css/tailwind.input.css)).
- Residual CSS constrained by [STYLING_CONTRACT.md](/frontend/STYLING_CONTRACT.md).
- Current direction: dark, data-dense “premium coaching workspace”, stronger hierarchy, selective accent usage, improved loading/error states.

### Frontend strengths
- Strong module split by view domain.
- Contract normalizers reduce backend drift breakage.
- URL-state navigation and keyboard shortcuts.
- Centralized job completion invalidation events.

### Frontend weaknesses
- Still template-string heavy in view modules (DOM diffing/composability limits).
- Large `dashboard.js` and `review.js` complexity.
- Some style rules duplicated between utility classes and custom CSS.
- Toast + polling logic is basic (no central notification store).

## 6. Backend Analysis

### API design
- Routers by domain: `games`, `stats`, `openings`, `drills`, `coach`, `jobs`, `product`, `sessions`, `reports`.
- Jobs endpoints are command-style (`POST /api/jobs/*`) and status is polled via `/api/jobs/status`.

### Separation of concerns
- Good: routers -> repository/services.
- Mixed: some business logic remains in routers (cache TTL maps, focus payload wiring).
- Async boundaries are mixed (sync DB ops + async endpoints for coach chat).

### Dependency/validation patterns
- `Depends(get_game_repo)` for DB-backed routes.
- Pydantic validation present in chat and drill result models.
- Many query params validated manually in routers.

### Error handling
- HTTPException on validation/availability/rate limits.
- Background job errors stored in queue recent history.
- Some endpoints silently return partial/fallback payloads.

### Maintainability observations
- `api/routers/stats.py` has module-level mutable caches (`_TTL_CACHE`, `lru_cache`) with no locking.
- `api/routers/reports.py` imports `BackgroundTasks` but no longer uses it.
- `coach/ollama_client.py` currently contains duplicated imports/function blocks (cleanup needed).

## 7. Database Analysis

### Schema structure
Core tables: `games`, `moves`, `mistakes`, `srs_items`, `player_profile`, `player_model_snapshots`, `journal_entries`, `sessions`, `schema_migrations`.

### Relationships
- `moves.game_id -> games.id`
- `mistakes.game_id -> games.id`, optional `mistakes.move_id -> moves.id`
- `srs_items.mistake_id -> mistakes.id`
- `journal_entries.game_id` unique FK to `games`

### Index coverage
- Good coverage for hot filters (`games` analyzed/date/opening/color/result, `mistakes` type/phase/game/eval, `moves` game/ply).
- Migration reconciled opening index to `(opening_eco, color, analyzed)`.

### Actual DB status (current)
- Counts: games 1088, moves 70555, mistakes 14536, srs_items 12369, journals 424, sessions 245.
- Migrations applied: 001, 002, 003.
- Integrity: `PRAGMA integrity_check = ok`, no FK violations.

### Model quality + debt
- SQLite schema and code are generally aligned after migrations.
- Some feature data is append-heavy (`player_model_snapshots`, reports) without retention policy.
- Timestamp fields are text-based and mixed (`date`, ISO strings, datetime()).

## 8. AI / Chess Intelligence System

### Stockfish pipeline
- Entry: [run_analysis_worker](/engine/stockfish_worker.py) scans `games.analyzed=0`.
- Per move: computes eval before; derives eval after from next ply; classifies player moves.
- Mistake extraction: thresholds + hanging-piece detection + critical move flag.
- Idempotent re-analysis by deleting prior `moves`/`mistakes` for game first.

### Classification and phase
- Uses shared helpers in [core/chess_utils.py](/core/chess_utils.py) (classify_move, phase detect, hanging logic).

### Ollama integration
- [coach/ollama_client.py](/coach/ollama_client.py): async client, chat stream/non-stream, model split fast vs full.
- Batch reports use `fast=True`; chat uses main model with injected player context.

### Prompt building/report generation
- [prompt_builder.py](/coach/prompt_builder.py): builds player context and per-game structured prompts.
- [game_report.py](/coach/game_report.py): async generation wrapped for sync callers, writes `journal_entries`.
- [weekly_report.py](/reports/weekly_report.py): weekly summary markdown with actionable sections.

### Drill/SRS logic
- [drills/srs_scheduler.py](/drills/srs_scheduler.py): SM-2 style update, due query, result writeback.
- Populates from high eval-loss mistakes not already in queue.

## 9. Current Features (Implemented)

| Area | Features | Maturity |
|---|---|---|
| Dashboard | KPI cards, win/mistake charts, weekly focus, next best step, session flow, recent games | **Partial-complete** |
| Onboarding | First-run modal detects empty `games`, prompts to start initial sync, dismissible state in localStorage ([frontend/js/modules/onboarding.js](/frontend/js/modules/onboarding.js)) | **Complete** |
| Games | Server-side filter/sort/pagination, preset filters, save/load filter slots, CSV export, summary copy | **Complete** |
| Game Review | Move-by-move workspace, board states, best move preview, critical mistakes panel, coach prompt handoff | **Partial-complete** |
| Mistakes | By-phase chart, blunder trend, heatmap, recurring motifs, critical mistakes table, phase tabs | **Complete** |
| Openings | Pre-aggregated summary, white/black charts, opening genome chart + insight, confidence badges | **Complete** |
| Drills | Due queue, board interaction, hint, quality scoring, streak/progress updates | **Complete** |
| Coach | Prompt chips, context panel, chat (stream-capable backend), memory preamble from recent sessions, time-pressure profile, thumbs feedback writes `coach_sessions.user_rating` | **Partial-complete** |
| Reports | Per-game journal entries + weekly markdown report generation. In-app `/reports` view shows latest + previous + history with markdown rendering ([frontend/js/modules/views/reports.js](/frontend/js/modules/views/reports.js)) | **Complete** |
| Jobs/Automation | Sync/analyze/sessions/player-model/weekly-report/db-maintenance queue endpoints + status polling. Durable `job_ledger` table records every transition; orphan jobs are reconciled on startup. New `/api/jobs/ledger` exposes the durable history. | **Complete** |
| Product analytics | Weekly focus API, player-model latest snapshot API | **Partial-complete** |

## 10. Current UX/UI State
- **Direction**: Elevated minimal dark coaching workspace, information-dense, utility-first styling.
- **Strengths**: Improved hierarchy, action surfaces, loading/error components, consistent navigation/actions.
- **Weaknesses**:
  - Some pages still feel dense (review/mistakes tables).
  - Complex views remain template-string heavy and hard to evolve.
  - Visual consistency still depends on mixed utility + residual CSS.
- **Responsiveness**: Good baseline with mobile bottom nav and breakpoint handling; still requires continued per-view tuning.

## 11. Security & Scalability Notes

### Security
- Optional admin auth only if `ADMIN_TOKEN` set; otherwise write endpoints are effectively open on allowed origins.
- In-memory IP rate limiting is present but per-process only.
- CSP/security headers are set at middleware.
- Request body size capped via `Content-Length` gate.
- Coach input sanitization is basic regex stripping (not robust trust boundary).

### Scalability
- Job queue is single process, single worker thread; no persistence across restarts.
- SQLite is appropriate for current single-user scale, but write-heavy analysis + large AI history may grow maintenance costs.
- Stats/product caches are in-process and non-distributed.
- Stockfish and Ollama are local bottlenecks; analysis/chat throughput limited by host CPU/RAM.

## 12. Technical Debt & Risks
- **Resolved (2026-05-27):** durable `job_ledger` table now records every enqueue/start/finish; orphan `queued`/`running` rows are reconciled on startup ([api/job_queue.py](/api/job_queue.py), [api/main.py](/api/main.py), migration 010).
- **Resolved (2026-05-27):** prior intel claim that `coach/ollama_client.py` had duplicate code blocks is incorrect — the file is ~100 lines, no duplication. Verified by direct read.
- **Resolved (2026-05-27):** `player_profile.hanging_piece_rate` formula corrected to `COUNT(DISTINCT game_id where type='hanging_piece') / analyzed_games`, capped at 1.0. Was previously reading 4.5+ on the production DB.
- **Resolved (2026-05-27):** repertoire ↔ SRS bridge (`repertoire_node_srs` table) — opening recall results now drive an SM-2 schedule. Coach context surfaces recently missed nodes.
- **Resolved (2026-05-27):** recurring-mistake motif clustering — `mistake_motifs` snapshot table populated by sync/analyze/player-model jobs; rule-based on `(subtype, phase, eco_family)` with min-3-occurrences threshold.
- **High**: Job retries are still single-attempt (ledger captures failures, but no automatic re-run policy).
- **Medium**: Mixed sync/async boundaries and thread-based async wrappers in report generation.
- **Medium**: Router-local caches (`stats`, `product`) are wrapped in `TTLCache` with `threading.Lock`, but `lru_cache` on `_get_cached_stats` is stdlib-thread-safe and unaudited for invalidation race semantics under heavy load.
- **Medium**: Frontend large modules (`dashboard.js`, `review.js`) are feature-rich but harder to maintain.
- **Low-medium**: Schema docs mostly aligned, but timestamp and data-retention policies are not standardized.
- **Low**: `BackgroundTasks` import unused in [api/routers/reports.py](/api/routers/reports.py).

## 13. Recommended Next Priorities
1. **LLM-driven motif labeling**: current motif clustering is rule-based on `(subtype, phase, eco_family)`. Next pass: name each cluster with an LLM ("back-rank weakness in C-family middlegames") so dashboard surfacing reads like coaching, not telemetry.
2. **Surface motifs and SRS-due nodes in the dashboard UI**: backend exposes `/api/product/motifs/latest` and `srs_due_nodes` in the training queue; the dashboard doesn't read them yet.
3. **Job retry policy**: extend the durable `job_ledger` with retry counters and exponential backoff on transient failures.
4. **Auth hardening**: deprecate the `ADMIN_TOKEN`-as-password fallback in [api/auth_service.py](/api/auth_service.py); require `ADMIN_PASSWORD_HASH` in production with a startup warning otherwise.
5. **Frontend maintainability**: split `dashboard.js` and `review.js` into smaller submodules (render/state/actions).
6. **AI safety/quality**: tighten chat input constraints; add per-mode timeouts and a fallback message when Ollama is slow.
7. **Data lifecycle**: retention policy for `player_model_snapshots`, `analytics_snapshots`, and stale SRS items. (`mistake_motifs` already has a 5-snapshot rolling cap.)
8. **Performance**: instrument slow SQL endpoints (`critical mistakes`, `heatmap`, `get_stats` bundle) with query plans before they degrade past 200k moves.

## 14. AI Guidance Section (For Future Assistants)

### Preserve these patterns
- Keep **Vanilla JS + ES modules** architecture.
- Keep **FastAPI + repository/service split**; avoid dumping SQL into routers.
- Keep endpoint contracts centralized in [frontend/js/modules/contracts.js](/frontend/js/modules/contracts.js).
- Keep Tailwind token authority in [frontend/css/tailwind.input.css](/frontend/css/tailwind.input.css); follow [frontend/STYLING_CONTRACT.md](/frontend/STYLING_CONTRACT.md).

### Preferred implementation style
- Small, surgical changes with clear ownership.
- Validate API shape with normalizers when adding/altering endpoints.
- For data-heavy UI changes, maintain loading/error/empty state consistency via shared helpers.
- Use job queue + invalidation events for long-running backend actions.

### Avoid
- Framework rewrites (React/Vue) unless explicitly requested.
- New generic CSS primitives in residual CSS modules.
- Bypassing repository layer for DB access in routers.
- Hardcoding API paths in views (use contracts module).

### Conventions to respect
- No inline styles in HTML templates.
- Keep touch targets >=44px on interactive controls.
- Keep chess-specific visuals (board/heatmap semantics) in `features.css`, not in generic primitive layer.
- Do not assume multi-user SaaS requirements; optimize for high-quality self-hosted single-user flow.

