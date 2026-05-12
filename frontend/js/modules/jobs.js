import { endpoints, normalize } from './contracts.js';
import { clearAllCaches } from './cache.js';

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

export async function waitForJobByPrefix(api, prefix, options = {}) {
  const {
    startedAtSec = Date.now() / 1000,
    timeoutMs = 180000,
    pollMs = 2500,
  } = options;

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const status = normalize.jobStatus(await api(endpoints.jobStatus()));
    const runningId = String(status?.id || '');
    const isActive = runningId.startsWith(prefix);
    const recent = findRecentJob(status, prefix, startedAtSec);

    if (recent?.status === 'completed') {
      emitInvalidation(recent);
      return { ok: true, job: recent, status };
    }
    if (recent?.status === 'failed') {
      return { ok: false, job: recent, status };
    }
    if (!isActive && status?.status === 'idle' && status?.queue_size === 0 && recent) {
      return { ok: recent.status === 'completed', job: recent, status };
    }

    await sleep(pollMs);
  }
  return { ok: false, timeout: true };
}
