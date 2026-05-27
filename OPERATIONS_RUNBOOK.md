# Operations Runbook

This runbook closes the current runtime/ops plan for the self-hosted Chess Coach deployment.

## 1. Runtime Model

The app runs as two systemd services:

- `chess-coach-api.service`: FastAPI/Uvicorn app, frontend static files, protected API, in-process job queue.
- `chess-coach-scheduler.service`: APScheduler process for nightly sync/analyze/SRS/session/player-model/report tasks.

Current runtime facts from the codebase:

- App entry point: `api.main:app`
- Scheduler entry point: `scheduler/jobs.py`
- Frontend: served from `frontend/index.html` and `frontend/*` (also `frontend/manifest.webmanifest` and `frontend/sw.js` at root scope — see §12)
- SPA routes served by FastAPI: `/`, `/dashboard`, `/games`, `/games/{game_id}`, `/game-detail`, `/mistakes`, `/openings`, `/drills`, `/coach`, `/reports`
- Database: `data/chess.db`
- SQLite mode: WAL via `api/db.py`
- Startup: validates config, runs pending migrations, starts the in-process job worker
- Shutdown: stops the in-process job worker
- Public health: `GET /api/health`
- Protected readiness: `GET /api/ready`
- Protected metrics: `GET /api/metrics`
- Background jobs: single in-process queue in `api/job_queue.py`
- External local dependencies: Stockfish at `STOCKFISH_PATH`, Ollama at `OLLAMA_URL`

Important operational constraints:

- **API queued jobs are durable.** As of H1, `job_ledger` records every enqueue/start/finish; orphan `queued`/`running` rows are reconciled on startup (marked `failed` with `error="lost on restart"`) and surfaced in `/api/jobs/status`. Transient failures retry with exponential backoff per `DEFAULT_MAX_RETRIES_BY_KIND` in `api/job_queue.py`. Re-trigger a manually-failed job from the actions menu or by re-POSTing the relevant `/api/jobs/*` endpoint.
- The scheduler is a separate process that writes to the same SQLite DB. Do not run more than one scheduler instance.
- Avoid triggering manual heavy sync/analyze jobs while scheduled jobs are running unless `/api/jobs/status` is idle.
- The what-if Stockfish engine is a long-lived module-level singleton (H11). It respawns automatically on `EngineTerminatedError`; no manual intervention needed unless `/api/metrics` shows it consistently failing.

## 2. Final Systemd Hardening Checklist

Sanitized example units are versioned in:

- `deploy/systemd/chess-coach-api.service.example`
- `deploy/systemd/chess-coach-scheduler.service.example`

Your current two-service structure is correct. The main changes recommended from the live units you shared are:

- Add `Group=chess_coach`.
- Add `EnvironmentFile=/home/chess_coach/chess-coach/.env` so production config is explicit.
- Use `network-online.target` instead of only `network.target`.
- Prefer `Restart=on-failure` instead of `Restart=always`.
- Prefer API binding to `127.0.0.1:8000` behind a reverse proxy; use `0.0.0.0` only if directly exposed behind firewall rules.
- Add systemd hardening: `NoNewPrivileges`, `PrivateTmp`, `ProtectSystem=full`, explicit `ReadWritePaths`, `UMask=0027`, `LimitNOFILE`.

API unit:

```ini
[Unit]
Description=Chess Coach API
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=chess_coach
Group=chess_coach
WorkingDirectory=/home/chess_coach/chess-coach
EnvironmentFile=/home/chess_coach/chess-coach/.env
Environment=PYTHONPATH=/home/chess_coach/chess-coach
ExecStart=/home/chess_coach/chess-coach/.venv/bin/uvicorn api.main:app --host 127.0.0.1 --port 8000 --proxy-headers
Restart=on-failure
RestartSec=5
TimeoutStopSec=30
KillSignal=SIGTERM

NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=full
ProtectHome=false
ReadWritePaths=/home/chess_coach/chess-coach/data /home/chess_coach/chess-coach/logs /home/chess_coach/chess-coach/reports
UMask=0027

LimitNOFILE=65535

[Install]
WantedBy=multi-user.target
```

Scheduler unit:

```ini
[Unit]
Description=Chess Coach Scheduler
After=network-online.target chess-coach-api.service
Wants=network-online.target

[Service]
Type=simple
User=chess_coach
Group=chess_coach
WorkingDirectory=/home/chess_coach/chess-coach
EnvironmentFile=/home/chess_coach/chess-coach/.env
Environment=PYTHONPATH=/home/chess_coach/chess-coach
ExecStart=/home/chess_coach/chess-coach/.venv/bin/python scheduler/jobs.py
Restart=on-failure
RestartSec=10
TimeoutStopSec=30
KillSignal=SIGTERM

NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=full
ProtectHome=false
ReadWritePaths=/home/chess_coach/chess-coach/data /home/chess_coach/chess-coach/logs /home/chess_coach/chess-coach/reports
UMask=0027

LimitNOFILE=65535

[Install]
WantedBy=multi-user.target
```

Checklist:

- Run as `chess_coach`, not `root`.
- Bind Uvicorn to `127.0.0.1:8000` when behind Nginx/Caddy.
- Keep only one `chess-coach-scheduler.service` instance enabled.
- Use HTTPS at the reverse proxy.
- Keep `.env` readable only by the service user.
- Ensure `data/`, `logs/`, and `reports/` are writable by `chess_coach`.
- Keep `ProtectSystem=full` plus explicit `ReadWritePaths`.
- Do not use multiple Uvicorn workers with the current in-process queue and SQLite write model.
- Use `Restart=on-failure`, not aggressive always-restart loops.
- Keep `ENABLE_DEBUG_ROUTES=false` in production.
- Keep Ollama private; do not expose `OLLAMA_URL` publicly.

Useful commands:

```bash
sudo cp deploy/systemd/chess-coach-api.service.example /etc/systemd/system/chess-coach-api.service
sudo cp deploy/systemd/chess-coach-scheduler.service.example /etc/systemd/system/chess-coach-scheduler.service
sudo systemctl daemon-reload
sudo systemctl enable chess-coach-api chess-coach-scheduler
sudo systemctl restart chess-coach-api chess-coach-scheduler
sudo systemctl status chess-coach-api --no-pager
sudo systemctl status chess-coach-scheduler --no-pager
```

If the API is not behind a local reverse proxy, change the API unit host from `127.0.0.1` back to `0.0.0.0` and protect port `8000` with firewall rules. For internet-facing production, the preferred deployment is still Uvicorn on `127.0.0.1` behind HTTPS reverse proxy.

## 3. Production Runtime Checklist

Required `.env` production posture:

```env
APP_ENV=production
APP_SECRET_KEY=<strong secret>
ADMIN_TOKEN=<strong token>
ADMIN_USERNAME=admin
ADMIN_PASSWORD_HASH=<pbkdf2 hash>
SESSION_COOKIE_NAME=chess_coach_session
SESSION_TTL_SECONDS=43200
ALLOWED_HOSTS=your.domain.example
CORS_ORIGINS=https://your.domain.example
ENABLE_DEBUG_ROUTES=false
RATE_LIMIT_BACKEND=sqlite
JOB_QUEUE_MAX_SIZE=100
MAX_REQUEST_BODY_BYTES=1048576
```

Required runtime dependencies:

- Python virtualenv with `requirements.txt`
- Node dependencies only when rebuilding CSS
- Stockfish installed at configured `STOCKFISH_PATH`
- Ollama running and reachable at `OLLAMA_URL`
- Ollama models configured for `OLLAMA_MODEL` and `OLLAMA_MODEL_FAST`

Before restart:

```bash
cd /home/chess_coach/chess-coach
. .venv/bin/activate
python3 -m py_compile api/main.py config.py api/db.py
npm run css:audit:migration
```

After restart:

```bash
curl -fsS https://your.domain.example/api/health
curl -fsS -H "X-ADMIN-TOKEN: $ADMIN_TOKEN" https://your.domain.example/api/ready
curl -fsS -H "X-ADMIN-TOKEN: $ADMIN_TOKEN" https://your.domain.example/api/metrics
```

Expected:

- `/api/health`: `ok=true`
- `/api/ready`: DB ok and job queue worker running
- `/api/metrics`: `db_ok=1`, `job_queue_worker_running=1`

## 4. Logging Playbook

Current logging behavior:

- FastAPI request logs include request ID, method, path, status, duration.
- Startup logs include environment, queue max size, debug route flag, applied migrations.
- Shutdown logs when job queue stop begins.
- Job queue logs queued/running/completed/failed jobs.
- DB maintenance logs integrity result, foreign-key violations, and estimated DB size.

Primary log source under systemd:

```bash
sudo journalctl -u chess-coach-api -n 200 --no-pager
sudo journalctl -u chess-coach-scheduler -n 200 --no-pager
sudo journalctl -u chess-coach-api -f
```

High-signal searches:

```bash
sudo journalctl -u chess-coach-api --since "1 hour ago" --no-pager | grep -E "ERROR|failed|exception|Traceback"
sudo journalctl -u chess-coach-api --since "1 hour ago" --no-pager | grep -E "startup|shutdown|migrations_applied|JobQueue"
sudo journalctl -u chess-coach-api --since "1 hour ago" --no-pager | grep -E "status=5|status=4"
sudo journalctl -u chess-coach-scheduler --since "24 hours ago" --no-pager | grep -E "ERROR|failed|exception|Traceback|sync|analyze|weekly|player model"
```

What to watch:

- Repeated `403 Forbidden`: usually unauthenticated browser/API access.
- `Job queue worker not running`: service should be restarted and `/api/ready` rechecked.
- `sqlite3.OperationalError: database is locked`: long write, permission issue, or competing process.
- Stockfish startup failures: verify `STOCKFISH_PATH`.
- Ollama HTTP failures: verify `OLLAMA_URL`, model names, and service status.
- Repeated job failures in `/api/jobs/status`: inspect recent job error and rerun after fixing root cause.

## 5. Health and Monitoring Playbook

Endpoints:

| Endpoint | Auth | Purpose |
| --- | --- | --- |
| `/api/health` | Public | Basic DB connectivity and feature availability. |
| `/api/ready` | Admin/session/token | DB readiness and job worker readiness. |
| `/api/metrics` | Admin/session/token | Operational counters for DB, queue, failed jobs, slow queries, Ollama breaker, environment. |
| `/api/jobs/status` | Admin/session/token | Current job and in-memory recent job history. |
| `/api/jobs/ledger?limit=50` | Admin/session/token | Durable history from `job_ledger` (survives restarts, unlike `/status` recent_jobs). |

Manual checks:

```bash
curl -fsS https://your.domain.example/api/health
curl -fsS -H "X-ADMIN-TOKEN: $ADMIN_TOKEN" https://your.domain.example/api/ready
curl -fsS -H "X-ADMIN-TOKEN: $ADMIN_TOKEN" https://your.domain.example/api/jobs/status
curl -fsS -H "X-ADMIN-TOKEN: $ADMIN_TOKEN" https://your.domain.example/api/jobs/ledger
```

`/api/metrics` keys (added across H1–H14):

- `db_ok` — 1/0
- `job_queue_size`, `job_queue_max_size`, `job_queue_worker_running`
- `job_recent_failed` — count in the in-memory ring
- `ollama_breaker` — `{open, open_until, recent_failures}` from the per-mode timeout circuit breaker (H3)
- `slow_queries` — `{threshold_ms, calls, slow_calls, recent_slow}`. Slow-query threshold is 250ms (H8). Anything that crosses it logs a warning and increments `slow_calls[name]`.
- `env` — `APP_ENV`

Alert-worthy conditions:

- `/api/health` fails.
- `/api/ready` returns non-2xx.
- `db_ok=0`.
- `job_queue_worker_running=0`.
- `job_queue_size` stays high for more than one analysis/report cycle.
- `job_recent_failed > 0` and failures repeat after retry.
- `ollama_breaker.open=true` for more than one cooldown window (~30s) — Ollama process is unhealthy.
- `slow_queries.slow_calls` shows a hot-path query repeatedly crossing the 250ms threshold — perf regression.
- Disk free space below 15%.
- `data/chess.db` or WAL files grow unexpectedly after large analysis runs.

Job ledger query (durable, survives restarts):

```bash
sqlite3 data/chess.db "SELECT status, COUNT(*) FROM job_ledger GROUP BY status;"
sqlite3 data/chess.db "SELECT job_id, status, error FROM job_ledger WHERE status='failed' ORDER BY enqueued_at DESC LIMIT 10;"
```

Disk checks:

```bash
df -h /home/chess_coach/chess-coach
du -h data/chess.db data/chess.db-wal data/chess.db-shm 2>/dev/null
```

## 6. Backup Playbook

Back up `data/chess.db`. This file now contains:

- synced game metadata
- move/mistake analysis
- player model snapshots
- sessions
- SRS/drill state
- generated puzzles
- coach sessions and local AI replies
- rate-limit events

Treat backups as sensitive.

Recommended backup command for a live SQLite WAL database:

```bash
mkdir -p /home/chess_coach/backups
sqlite3 /home/chess_coach/chess-coach/data/chess.db ".backup '/home/chess_coach/backups/chess-$(date +%F-%H%M%S).db'"
```

Then optionally compress:

```bash
gzip /home/chess_coach/backups/chess-YYYY-MM-DD-HHMMSS.db
```

Retention suggestion for a self-hosted single-user deployment:

- Keep hourly backups for 24 hours if actively developing.
- Keep daily backups for 14 days.
- Keep weekly backups for 8 weeks.
- Copy at least one backup off the VM.

Cron example:

```cron
15 2 * * * sqlite3 /home/chess_coach/chess-coach/data/chess.db ".backup '/home/chess_coach/backups/chess-$(date +\%F).db'"
30 2 * * * find /home/chess_coach/backups -name 'chess-*.db' -mtime +14 -delete
```

Backup validation:

```bash
sqlite3 /home/chess_coach/backups/chess-YYYY-MM-DD.db "PRAGMA integrity_check;"
sqlite3 /home/chess_coach/backups/chess-YYYY-MM-DD.db "PRAGMA foreign_key_check;"
```

Expected:

- `integrity_check` returns `ok`
- `foreign_key_check` returns no rows

## 7. Restore Playbook

Stop the service:

```bash
sudo systemctl stop chess-coach-scheduler chess-coach-api
```

Preserve current DB before replacing:

```bash
cd /home/chess_coach/chess-coach
cp data/chess.db data/chess.db.before-restore.$(date +%F-%H%M%S)
```

Restore:

```bash
cp /home/chess_coach/backups/chess-YYYY-MM-DD.db data/chess.db
chown chess_coach:chess_coach data/chess.db
chmod 640 data/chess.db
rm -f data/chess.db-wal data/chess.db-shm
```

Start and verify:

```bash
sudo systemctl start chess-coach-api chess-coach-scheduler
curl -fsS https://your.domain.example/api/health
curl -fsS -H "X-ADMIN-TOKEN: $ADMIN_TOKEN" https://your.domain.example/api/ready
```

Run DB maintenance after restore:

```bash
cd /home/chess_coach/chess-coach
. .venv/bin/activate
python3 scripts/db_maintenance.py
```

## 8. DB Maintenance Playbook

Manual maintenance:

```bash
cd /home/chess_coach/chess-coach
. .venv/bin/activate
python3 scripts/db_maintenance.py
```

API/job maintenance:

```bash
curl -fsS -X POST -H "X-ADMIN-TOKEN: $ADMIN_TOKEN" https://your.domain.example/api/jobs/db-maintenance
curl -fsS -H "X-ADMIN-TOKEN: $ADMIN_TOKEN" https://your.domain.example/api/jobs/status
```

Use `VACUUM` only during a maintenance window:

```bash
curl -fsS -X POST -H "X-ADMIN-TOKEN: $ADMIN_TOKEN" "https://your.domain.example/api/jobs/db-maintenance?vacuum=true"
```

Notes:

- `ANALYZE` is safe and updates query planner stats.
- `VACUUM` can be expensive and needs temporary disk space.
- Always back up before `VACUUM` if the DB recently changed heavily.

## 9. Release and Restart Checklist

Before deploy:

- Check `git status`.
- Rebuild CSS if frontend styles changed: `npm run css:build`.
- Run frontend migration audit: `npm run css:audit:migration`.
- Run Python syntax checks for touched files.
- Back up `data/chess.db`.
- Confirm `.env` production settings are still correct.

Deploy:

```bash
sudo systemctl restart chess-coach-api chess-coach-scheduler
sudo journalctl -u chess-coach-api -n 100 --no-pager
sudo journalctl -u chess-coach-scheduler -n 100 --no-pager
```

Post-deploy:

- `/api/health` returns ok.
- `/api/ready` returns ok.
- Login overlay works.
- Dashboard loads after login without manual refresh.
- `/api/jobs/status` is protected and returns worker status.
- Drills page loads daily queue.
- Puzzle generation job reports completion in the UI.
- Coach chat returns a response if Ollama is running.

## 10. Incident Response Quick Reference

Service down:

```bash
sudo systemctl status chess-coach-api --no-pager
sudo journalctl -u chess-coach-api -n 200 --no-pager
curl -fsS https://your.domain.example/api/health
```

Jobs stuck:

```bash
curl -fsS -H "X-ADMIN-TOKEN: $ADMIN_TOKEN" https://your.domain.example/api/jobs/status
sudo systemctl restart chess-coach-api
```

Scheduler issue:

```bash
sudo systemctl status chess-coach-scheduler --no-pager
sudo journalctl -u chess-coach-scheduler -n 200 --no-pager
sudo systemctl restart chess-coach-scheduler
```

DB issue:

```bash
sqlite3 /home/chess_coach/chess-coach/data/chess.db "PRAGMA integrity_check;"
sqlite3 /home/chess_coach/chess-coach/data/chess.db "PRAGMA foreign_key_check;"
python3 /home/chess_coach/chess-coach/scripts/db_maintenance.py
```

Ollama issue:

```bash
curl -fsS http://localhost:11434/api/tags
sudo systemctl status ollama --no-pager
```

Stockfish issue:

```bash
/usr/games/stockfish
```

Permission issue:

```bash
namei -l /home/chess_coach/chess-coach
ls -la /home/chess_coach/chess-coach/data
sudo chown -R chess_coach:chess_coach /home/chess_coach/chess-coach/data /home/chess_coach/chess-coach/logs /home/chess_coach/chess-coach/reports
```

## 11. Known Ops Risks

- ~~Job queue is in-process and not restart-durable.~~ **Resolved (H1):** `job_ledger` table records every enqueue/start/finish; orphan `queued`/`running` rows are reconciled on startup and surfaced in `/api/jobs/status`. Transient failures retry per `DEFAULT_MAX_RETRIES_BY_KIND` in `api/job_queue.py`.
- SQLite is correct for this single-user deployment, but long writes can still block concurrent work. Schedule heavy `analyze` and `db-maintenance` outside dashboard-use hours.
- Ollama and Stockfish are local CPU-heavy dependencies; job runtime depends on hardware. The Stockfish what-if pool is long-lived (H11) but `analyze` still spawns its own engine per batch.
- Coach sessions and generated puzzles increase DB sensitivity and backup importance.
- Systemd examples are sanitized; keep `/etc/systemd/system/*.service` aligned after local path or binding changes.

## 12. PWA Service Worker

The frontend is PWA-installable as of H14. Two static assets ship at root scope (not `/static/`):

| Path | File on disk | Served by |
|---|---|---|
| `/manifest.webmanifest` | `frontend/manifest.webmanifest` | `api.main.serve_manifest` |
| `/sw.js` | `frontend/sw.js` | `api.main.serve_service_worker` |

Both are served with `Cache-Control: no-cache` so updates land on the next reload.

### Cache strategy

The service worker keeps three named caches, each suffixed with `CACHE_VERSION` (currently `v1`):

| Cache | Strategy | Contents |
|---|---|---|
| `cc-shell-v1` | stale-while-revalidate | HTML, CSS, JS, view templates |
| `cc-fonts-v1` | cache-first | Manrope from fonts.gstatic.com |
| `cc-api-v1` | network-first with cached fallback | `/api/drills/due` (only) |

All other API calls are passed through to the network without interception.

### Forcing an update after a deploy

When you change anything in `frontend/sw.js` or want the shell cache invalidated globally:

1. Bump the `CACHE_VERSION` constant near the top of `frontend/sw.js`.
2. Restart the API service so the new file is served.
3. Open the app — the `activate` event purges any cache key that doesn't end in the new `CACHE_VERSION`, then `clients.claim()` takes control of open tabs.

If a user reports stale UI and DevTools shows a stuck `redundant` worker, they can right-click in Application → Service Workers → Unregister, or clear site data. This is rare; the stale-while-revalidate strategy normally self-heals.

### What is NOT cached offline

Intentionally:
- Game detail (`/api/games/{id}`) — could mislead about analysis state
- Stats (`/api/stats`) — context-sensitive, would be misleading stale
- Coach chat — needs Ollama up
- All mutations (POST/PUT/DELETE) — never serve a "stale write"

The drill queue is the one exception, cached so today's drills are usable on the train.

### Verifying

```bash
# Manifest reachable + correct content type
curl -sI http://localhost:8000/manifest.webmanifest | head -3

# Service worker reachable
curl -sI http://localhost:8000/sw.js | head -3

# Lighthouse PWA audit
# (in browser DevTools → Lighthouse → Progressive Web App)
```

In the browser, look for a "service worker activated and is controlling this page" line in DevTools → Application → Service Workers.

## 13. Documentation

This runbook covers production ops. For day-to-day work:

- `README.md` — elevator pitch, stack, quick-start
- `AGENTS.md` — doc-update contract; when to bump what
- `CHANGELOG.md` — horizon-by-horizon history
- `PROJECT_INTELLIGENCE.md` — architecture intel and current technical debt
- `API_SECURITY_GUIDE.md` — auth, rate limits, CSP, threat model
- `frontend/STYLING_CONTRACT.md` — design system rules
- `frontend/design/COMPONENT_CONTRACTS.md` — Lit primitive APIs

Bump this runbook when systemd, env vars, deploy steps, backup/restore, or PWA caching change. The doc-update contract in AGENTS.md is the source of truth for who-bumps-what.
