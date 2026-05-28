# Chess Coach

A self-hosted, single-user AI chess coaching workspace. It pulls your rapid games from Chess.com, analyzes them with Stockfish, turns recurring mistakes into a spaced-repetition drill queue, and pairs you with a memoryful Ollama-backed coach that reads your data instead of inventing it.

The product loop is **sync → analyze → drill → coach → review → reflect**. The differentiator is that drills come from your own real mistakes (not a generic puzzle bank), the coach remembers what you discussed last week, and the review board lets you drag any move to ask "what if I'd played this instead?"

> Single-user, self-hosted by design. No multi-tenant, no SaaS, no telemetry. Runs on a Pi or a small VM.

---

## What's in here

**Core flow**
- Sync rapid games from Chess.com (`sync/fetch_games.py`)
- Stockfish analysis at adaptive depth, mistake classification, hanging-piece detection (`engine/stockfish_worker.py`, `core/chess_utils.py`)
- SM-2 spaced-repetition drill queue from your real mistakes (`drills/srs_scheduler.py`)
- Recurring-motif clustering with optional LLM-generated coaching labels (`api/services/mistake_motifs.py`)
- Memoryful Ollama coach with mode-aware prompts and what-if exploration (`coach/`, `engine/eval_position.py`)
- Weekly markdown reports with last-week reflection (`reports/weekly_report.py`)
- Player-model snapshots, opening repertoire ↔ SRS bridge, time-pressure profile

**Surfaces**
- 8-view SPA: dashboard, games, game-detail (review), mistakes, openings, drills, coach, reports
- Drag-and-drop chess board with promotion picker; click-to-move fallback
- Review board with what-if drag, depth slider, best-move arrow, persisted exploration history
- Dashboard focus mode (default-on for new sessions)
- Drill streaks, motif panel with LLM labels, in-app weekly reports
- PWA-installable (manifest + service worker, app-shell + offline drill queue)

**Hardening**
- Durable `job_ledger` with retry policy and restart recovery
- Per-mode Ollama timeouts + circuit breaker (60s chat / 30s batch, opens after 3 failures in 60s)
- Slow-query instrumentation @ 250ms threshold, exposed at `/api/metrics`
- Append-only-table retention policy (90d snapshots, 365d coach sessions)
- Auth hardening: production refuses to boot without `ADMIN_PASSWORD_HASH`
- Frontend gate: caps inline arbitrary Tailwind values at 25 (current 22)

---

## Stack

| Layer | Tech |
|---|---|
| Frontend | Vanilla ES modules + Tailwind v4 + daisyUI + Lit web components (loaded via jsdelivr) |
| Backend | FastAPI 0.128 + Uvicorn |
| Database | SQLite (WAL) at `data/chess.db` |
| Engine | `python-chess` + local Stockfish at `/usr/games/stockfish` |
| LLM | Local Ollama HTTP API; two models — 14B chat (`OLLAMA_MODEL`) and 7B batch (`OLLAMA_MODEL_FAST`) |
| Jobs | In-process singleton queue + worker thread; durable `job_ledger` table |
| Scheduler | Separate APScheduler process (`scheduler/`) |
| Design tokens | `frontend/design/tokens.json` → generated `theme.ts` (RN-shape) |

---

## Quick start

### Prerequisites

- Python 3.10+
- Node 20+ (for Tailwind build)
- Stockfish binary (`apt install stockfish` on Debian/Ubuntu)
- Ollama running locally with two models pulled (see `.env.example`)
- A Chess.com username

### Install

```bash
git clone <this-repo> chess-coach
cd chess-coach
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
npm install
cp .env.example .env
# Edit .env — at minimum set CHESS_USERNAME and APP_SECRET_KEY
```

For production, generate `ADMIN_PASSWORD_HASH`:
```bash
python3 -c "from api.auth_service import create_password_hash; import getpass; print(create_password_hash(getpass.getpass('Admin password: ')))"
```

### Build the frontend

```bash
npm run css:build     # one-shot Tailwind build
npm run css:watch     # watch mode for development
npm run frontend:gate # design-system audit (must pass before merge)
```

### Run

```bash
# Dev: API only (frontend served as static)
uvicorn api.main:app --host 0.0.0.0 --port 8000 --reload

# Or via systemd in production — see deploy/systemd/ and OPERATIONS_RUNBOOK.md
```

Visit `http://localhost:8000`. First load triggers the onboarding modal; click **Sync** to pull your games, then **Analyze** to classify mistakes. The drill queue and coach context populate from there.

### Optional design-token regeneration

```bash
node frontend/design/build-tokens.mjs
```

Regenerates `frontend/design/theme.ts` from `tokens.json`. Tokens.json is the single source of design truth for any future React Native port.

---

## Documentation map

Everything is at the repo root or one level down. Pick the doc that matches your task:

| Document | When to read |
|---|---|
| **[README.md](README.md)** (this file) | First time here; want the elevator pitch, stack, and how to run |
| **[CHANGELOG.md](CHANGELOG.md)** | What changed and when, organized by polish horizon |
| **[PROJECT_INTELLIGENCE.md](PROJECT_INTELLIGENCE.md)** | Architecture deep-dive: data flow, schema, services, technical debt, next priorities |
| **[OPERATIONS_RUNBOOK.md](OPERATIONS_RUNBOOK.md)** | Production deploy, systemd hardening, incident response, backup/restore |
| **[API_SECURITY_GUIDE.md](API_SECURITY_GUIDE.md)** | Security posture: auth, rate limits, CSP, threat model |
| **[frontend/STYLING_CONTRACT.md](frontend/STYLING_CONTRACT.md)** | Design system rules: token authority, color discipline, what NOT to add |
| **[frontend/design/COMPONENT_CONTRACTS.md](frontend/design/COMPONENT_CONTRACTS.md)** | Lit primitive props/events — also the contract a future RN port consumes |

If you can't find what you need from one of these, prefer adding a section to the existing closest-fit doc over creating a new file. Doc proliferation is its own kind of decay.

---

## Project status

The codebase has shipped 14 polish horizons since the original product audit. See [CHANGELOG.md](CHANGELOG.md) for the full history. Current state:

- **Maturity:** functional beta, polished
- **Mobile:** responsive web + PWA installable; React Native port is design-ready but not started
- **Multi-user / SaaS:** explicitly not in scope
- **Open issues / next priorities:** see PROJECT_INTELLIGENCE.md §13

---

## License

Personal/educational use. The repo carries no public license; treat it as private code unless that changes.
