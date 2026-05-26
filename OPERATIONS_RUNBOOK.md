# Operations Runbook

This runbook closes the current runtime/ops plan for the self-hosted Chess Coach deployment.

## 1. Runtime Model

The app runs as two systemd services:

- `chess-coach-api.service`: FastAPI/Uvicorn app, frontend static files, protected API, in-process job queue.
- `chess-coach-scheduler.service`: APScheduler process for nightly sync/analyze/SRS/session/player-model/report tasks.

Current runtime facts from the codebase:

- App entry point: `api.main:app`
- Scheduler entry point: `scheduler/jobs.py`
- Frontend: served from `frontend/index.html` and `frontend/*`
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

- API queued jobs are not durable across service restarts. If the API process restarts while sync, analysis, coach reports, or puzzle generation are queued/running, re-run that job manually.
- The scheduler is a separate process that writes to the same SQLite DB. Do not run more than one scheduler instance.
- Avoid triggering manual heavy sync/analyze jobs while scheduled jobs are running unless `/api/jobs/status` is idle.

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
| `/api/metrics` | Admin/session/token | Operational counters for DB, queue, failed jobs, environment. |
| `/api/jobs/status` | Admin/session/token | Current job and recent job history. |

Manual checks:

```bash
curl -fsS https://your.domain.example/api/health
curl -fsS -H "X-ADMIN-TOKEN: $ADMIN_TOKEN" https://your.domain.example/api/ready
curl -fsS -H "X-ADMIN-TOKEN: $ADMIN_TOKEN" https://your.domain.example/api/jobs/status
```

Alert-worthy conditions:

- `/api/health` fails.
- `/api/ready` returns non-2xx.
- `db_ok=0`.
- `job_queue_worker_running=0`.
- `job_queue_size` stays high for more than one analysis/report cycle.
- `job_recent_failed > 0` and failures repeat after retry.
- Disk free space below 15%.
- `data/chess.db` or WAL files grow unexpectedly after large analysis runs.

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

- Job queue is in-process and not restart-durable.
- SQLite is correct for this single-user deployment, but long writes can still block concurrent work.
- Ollama and Stockfish are local CPU-heavy dependencies; job runtime depends on hardware.
- Coach sessions and generated puzzles increase DB sensitivity and backup importance.
- Systemd examples are sanitized; keep `/etc/systemd/system/*.service` aligned after local path or binding changes.
