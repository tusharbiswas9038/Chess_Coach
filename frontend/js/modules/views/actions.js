import { createDomCache } from '../dom.js';
import { endpoints } from '../contracts.js';
import { waitForJobByPrefix } from '../jobs.js';

export function createActionsView({ api, apiPost, onReportReady, toast }) {
  const dom = createDomCache();

  function closeActionsMenu() {
    const container = dom.query('.topbar-actions');
    const toggle = dom.byId('btn-actions-menu');
    const list = dom.byId('topbar-actions-list');
    if (!container || !toggle) return;
    container.classList.remove('is-open');
    if (list) {
      list.dataset.open = 'false';
      if (window.matchMedia('(max-width: 640px)').matches) {
        list.style.display = 'none';
      }
    }
    toggle.setAttribute('aria-expanded', 'false');
  }

  function toggleActionsMenu() {
    const container = dom.query('.topbar-actions');
    const toggle = dom.byId('btn-actions-menu');
    const list = dom.byId('topbar-actions-list');
    if (!container || !toggle) return;
    const nextOpen = !container.classList.contains('is-open');
    container.classList.toggle('is-open', nextOpen);
    if (list) {
      list.dataset.open = nextOpen ? 'true' : 'false';
      if (window.matchMedia('(max-width: 640px)').matches) {
        list.style.display = nextOpen ? 'flex' : 'none';
      }
    }
    toggle.setAttribute('aria-expanded', nextOpen ? 'true' : 'false');
  }

  async function triggerSync() {
    const btn = dom.byId('btn-sync');
    btn.disabled = true;
    btn.textContent = 'Syncing…';
    try {
      const startedAtSec = Date.now() / 1000;
      await apiPost(endpoints.jobSync());
      toast('Sync started. Check back in a minute.');
      const result = await waitForJobByPrefix(api, 'sync', { startedAtSec });
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
      btn.textContent = 'Sync';
      closeActionsMenu();
    }
  }

  async function triggerAnalyze() {
    const btn = dom.byId('btn-analyze');
    btn.disabled = true;
    btn.textContent = 'Analyzing…';
    try {
      const startedAtSec = Date.now() / 1000;
      await apiPost(endpoints.jobAnalyze());
      toast('Analysis started. This may take a few minutes.');
      const result = await waitForJobByPrefix(api, 'analyze', {
        startedAtSec,
        timeoutMs: 480000,
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
      btn.textContent = 'Analyze';
      closeActionsMenu();
    }
  }

  async function triggerDbMaintenance() {
    const btn = dom.byId('btn-db-maintenance');
    btn.disabled = true;
    btn.textContent = 'Optimizing…';
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
      btn.textContent = 'DB Optimize';
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

    if (actionsList && window.matchMedia('(max-width: 640px)').matches) {
      actionsList.style.display = 'none';
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
