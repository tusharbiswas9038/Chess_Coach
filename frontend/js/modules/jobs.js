import { endpoints, normalize } from './contracts.js';
import { clearAllCaches } from './cache.js';

const JOB_SESSION_KEY = 'cc.active_job';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function findRecentJob(status, prefix, startedAtSec) {
  const recent = Array.isArray(status?.recent_jobs) ? status.recent_jobs : [];
  return recent.find(
    (job) => job?.id?.startsWith(prefix) && Number(job?.finished_at || 0) >= startedAtSec
  );
}

function emitInvalidation(job) {
  const scopes = Array.isArray(job?.invalidates) ? job.invalidates : [];
  if (scopes.length === 0) return;

  clearAllCaches();
  document.dispatchEvent(
    new CustomEvent('app:data-invalidated', {
      detail: {
        scopes,
        source: job.source || job.id || 'job',
        event: job.event || 'analytics:invalidated',
        finishedAt: job.finished_at || Date.now() / 1000,
      },
    })
  );
  if (scopes.includes('games') || scopes.includes('analytics')) {
    document.dispatchEvent(
      new CustomEvent('data:games-updated', {
        detail: { source: job.source || job.id || 'job', scopes },
      })
    );
  }
}

// Persist active job across page refreshes
function saveActiveJob(prefix, startedAtSec) {
  try {
    sessionStorage.setItem(JOB_SESSION_KEY, JSON.stringify({ prefix, startedAtSec }));
  } catch (_) {}
}

function clearActiveJob() {
  try { sessionStorage.removeItem(JOB_SESSION_KEY); } catch (_) {}
}

export function getPersistedJob() {
  try {
    const raw = sessionStorage.getItem(JOB_SESSION_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch (_) { return null; }
}

export function formatProgress(progress) {
  if (!progress || !progress.total) return null;
  const pct = Math.round((progress.done / progress.total) * 100);
  return `${progress.done}/${progress.total} (${pct}%)`;
}

export async function waitForJobByPrefix(api, prefix, options = {}) {
  const {
    startedAtSec = Date.now() / 1000,
    timeoutMs = 180000,
    pollMs = 2500,
    onProgress = null,
  } = options;

  saveActiveJob(prefix, startedAtSec);

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const status = normalize.jobStatus(await api(endpoints.jobStatus()));
    const runningId = String(status?.id || '');
    const isActive = runningId.startsWith(prefix);
    const recent = findRecentJob(status, prefix, startedAtSec);

    // Report progress to caller
    if (isActive && status?.progress && onProgress) {
      onProgress(status.progress);
    }

    if (recent?.status === 'completed') {
      clearActiveJob();
      emitInvalidation(recent);
      return { ok: true, job: recent, status };
    }
    if (recent?.status === 'failed') {
      clearActiveJob();
      return { ok: false, job: recent, status };
    }
    if (!isActive && status?.status === 'idle' && status?.queue_size === 0 && recent) {
      clearActiveJob();
      return { ok: recent.status === 'completed', job: recent, status };
    }

    await sleep(pollMs);
  }
  clearActiveJob();
  return { ok: false, timeout: true };
}
