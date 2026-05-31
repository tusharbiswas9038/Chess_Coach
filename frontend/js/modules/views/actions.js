import { createDomCache } from '../dom.js';
import { endpoints } from '../contracts.js';
import { waitForJobByPrefix, getPersistedJob, formatProgress } from '../jobs.js';

export function createActionsView({ api, apiPost, onLogout, onReportReady, toast }) {
  const dom = createDomCache();

  function closeActionsMenu() {
    const container = dom.query('.topbar-actions');
    const toggle = dom.byId('btn-actions-menu');
    const list = dom.byId('topbar-actions-list');
    if (!container || !toggle) return;
    container.classList.remove('is-open');
    if (list) list.dataset.open = 'false';
    toggle.setAttribute('aria-expanded', 'false');
  }

  function toggleActionsMenu() {
    const container = dom.query('.topbar-actions');
    const toggle = dom.byId('btn-actions-menu');
    const list = dom.byId('topbar-actions-list');
    if (!container || !toggle) return;
    const nextOpen = !container.classList.contains('is-open');
    container.classList.toggle('is-open', nextOpen);
    if (list) list.dataset.open = nextOpen ? 'true' : 'false';
    toggle.setAttribute('aria-expanded', nextOpen ? 'true' : 'false');
  }

  function setActionLabel(btn, text) {
    if (!btn) return;
    const label = btn.querySelector('span');
    if (label) {
      label.textContent = text;
    } else {
      btn.textContent = text;
    }
  }

  async function triggerSync() {
    const btn = dom.byId('btn-sync');
    btn.disabled = true;
    setActionLabel(btn, 'Syncing…');
    try {
      const startedAtSec = Date.now() / 1000;
      await apiPost(endpoints.jobSync());
      toast('Sync started — fetching all your rapid games.');
      const result = await waitForJobByPrefix(api, 'sync', {
        startedAtSec,
        onProgress: (p) => {
          const label = formatProgress(p);
          if (label) setActionLabel(btn, `Syncing ${label}`);
        },
      });
      if (result.ok) {
        toast('Sync completed.');
      } else if (result.timeout) {
        toast('Sync is still running in background');
      } else {
        toast(`Sync job failed: ${result.job?.error || 'unknown error'}`);
      }
    } catch (e) {
      toast(`Sync failed: ${e.message}`);
    } finally {
      btn.disabled = false;
      setActionLabel(btn, 'Sync');
      closeActionsMenu();
    }
  }

  async function triggerAnalyze() {
    const btn = dom.byId('btn-analyze');
    btn.disabled = true;
    setActionLabel(btn, 'Analyzing…');
    try {
      const startedAtSec = Date.now() / 1000;
      await apiPost(endpoints.jobAnalyze());
      toast('Analysis started. This may take a few minutes.');
      const result = await waitForJobByPrefix(api, 'analyze', {
        startedAtSec,
        timeoutMs: 480000,
        onProgress: (p) => {
          const label = formatProgress(p);
          if (label) setActionLabel(btn, `Analyzing ${label}`);
        },
      });
      if (result.ok) {
        toast('Analysis completed.');
      } else if (result.timeout) {
        toast('Analysis is still running in background');
      } else {
        toast(`Analysis job failed: ${result.job?.error || 'unknown error'}`);
      }
    } catch (e) {
      toast(`Analyze failed: ${e.message}`);
    } finally {
      btn.disabled = false;
      setActionLabel(btn, 'Analyze');
      closeActionsMenu();
    }
  }

  // Re-attach to any job that was running — works across devices and page refreshes.
  // Checks the server directly rather than relying on sessionStorage.
  async function resumePersistedJob() {
    try {
      const { normalize, endpoints: ep } = await import('../contracts.js');
      const status = normalize.jobStatus(await api(ep.jobStatus()));
      const runningId = String(status?.id || '');
      if (!runningId || status?.status !== 'running') return;

      const prefix = runningId.startsWith('sync') ? 'sync'
        : runningId.startsWith('analyze') ? 'analyze'
        : null;
      if (!prefix) return;

      // Use a startedAtSec far in the past so we match any recent completion
      const startedAtSec = (Date.now() / 1000) - 3600;
      const btn = prefix === 'sync' ? dom.byId('btn-sync') : dom.byId('btn-analyze');
      if (!btn) return;

      btn.disabled = true;
      setActionLabel(btn, prefix === 'sync' ? 'Syncing…' : 'Analyzing…');

      const result = await waitForJobByPrefix(api, prefix, {
        startedAtSec,
        timeoutMs: prefix === 'analyze' ? 480000 : 180000,
        onProgress: (p) => {
          const label = formatProgress(p);
          if (label) setActionLabel(btn, `${prefix === 'sync' ? 'Syncing' : 'Analyzing'} ${label}`);
        },
      });

      if (result.ok) {
        toast(`${prefix === 'sync' ? 'Sync' : 'Analysis'} completed.`);
      } else if (result.timeout) {
        // still running, leave button in disabled state — next poll will update
      } else if (result.job) {
        toast(`${prefix === 'sync' ? 'Sync' : 'Analysis'} job failed: ${result.job?.error || 'unknown error'}`);
      }
      btn.disabled = false;
      setActionLabel(btn, prefix === 'sync' ? 'Sync' : 'Analyze');
    } catch (_) {}
  }

  async function triggerDbMaintenance() {
    const btn = dom.byId('btn-db-maintenance');
    btn.disabled = true;
    setActionLabel(btn, 'Optimizing…');
    try {
      const startedAtSec = Date.now() / 1000;
      await apiPost(endpoints.jobDbMaintenance(), { vacuum: false });
      toast('Database optimization queued.');
      const result = await waitForJobByPrefix(api, 'db-maintenance', { startedAtSec });
      if (result.ok) {
        toast('Database optimization completed.');
      } else if (result.timeout) {
        toast('DB optimization is still running in background');
      } else {
        toast(`DB optimization failed: ${result.job?.error || 'unknown error'}`);
      }
    } catch (e) {
      toast(`DB optimization failed: ${e.message}`);
    } finally {
      btn.disabled = false;
      setActionLabel(btn, 'DB Optimize');
      closeActionsMenu();
    }
  }

  async function triggerClearMotifLabels() {
    const btn = dom.byId('btn-clear-motif-labels');
    if (!btn) return;
    btn.disabled = true;
    const label = btn.querySelector('span');
    const original = label ? label.textContent : btn.textContent;
    setActionLabel(btn, 'Clearing…');
    try {
      const result = await apiPost(endpoints.motifsClearLabels(), {});
      const rows = Number(result?.rows ?? 0);
      toast(
        rows
          ? `Cleared ${rows} motif label${rows === 1 ? '' : 's'}. Run analyze to regenerate.`
          : 'No motif labels to clear.'
      );
    } catch (e) {
      toast(`Could not clear motif labels: ${e.message}`);
    } finally {
      btn.disabled = false;
      setActionLabel(btn, original);
      closeActionsMenu();
    }
  }

  async function generateReport(gameId) {
    toast('Generating coach note — takes ~30 seconds...');
    try {
      await apiPost(endpoints.coachGame(gameId));
      const poll = setInterval(async () => {
        try {
          const data = await api(endpoints.gameDetail(gameId));
          if (data.journal) {
            clearInterval(poll);
            toast('Coach note ready.');
            onReportReady(gameId);
          }
        } catch (e) {
          clearInterval(poll);
          toast(`Polling failed: ${e.message}`);
        }
      }, 5000);
      setTimeout(() => clearInterval(poll), 180000);
    } catch (e) {
      toast(`Failed: ${e.message}`);
    }
  }

  function bindEvents() {
    const actionsToggleBtn = dom.byId('btn-actions-menu');
    const actionsList = dom.byId('topbar-actions-list');

    if (actionsList) {
      actionsList.dataset.open = 'false';
    }

    if (actionsToggleBtn) {
      const onToggle = (event) => {
        event.preventDefault();
        event.stopPropagation();
        toggleActionsMenu();
      };
      actionsToggleBtn.addEventListener('pointerup', onToggle);
      actionsToggleBtn.addEventListener('keydown', (event) => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        onToggle(event);
      });
    }

    window.addEventListener('resize', () => {
      if (!window.matchMedia('(max-width: 640px)').matches) {
        const actionsListEl = dom.byId('topbar-actions-list');
        if (actionsListEl) actionsListEl.style.display = '';
      }
    });

    dom.byId('btn-sync').addEventListener('click', triggerSync);
    dom.byId('btn-analyze').addEventListener('click', triggerAnalyze);
    dom.byId('btn-db-maintenance')?.addEventListener('click', triggerDbMaintenance);
    dom.byId('btn-clear-motif-labels')?.addEventListener('click', triggerClearMotifLabels);
    dom.byId('btn-logout')?.addEventListener('click', async () => {
      closeActionsMenu();
      await onLogout?.();
    });

    // Re-attach to any job that was running before a page refresh
    resumePersistedJob();

    document.addEventListener('click', (event) => {
      const container = dom.query('.topbar-actions');
      if (!container || !container.classList.contains('is-open')) return;
      if (event.target.closest('.topbar-actions')) return;
      closeActionsMenu();
    });

    document.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape') return;
      closeActionsMenu();
    });
  }

  return {
    bindEvents,
    generateReport,
  };
}
