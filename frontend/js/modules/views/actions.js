export function createActionsView({ api, apiPost, onReportReady, toast }) {
  async function triggerSync() {
    const btn = document.getElementById('btn-sync');
    btn.disabled = true;
    btn.textContent = 'Syncing…';
    try {
      await apiPost('/api/sync');
      toast('✓ Sync started — check back in a minute');
    } catch (e) {
      toast('Sync failed: ' + e.message);
    }
    setTimeout(() => {
      btn.disabled = false;
      btn.innerHTML = '↺ Sync';
    }, 3000);
  }

  async function triggerAnalyze() {
    const btn = document.getElementById('btn-analyze');
    btn.disabled = true;
    btn.textContent = 'Analyzing…';
    try {
      await apiPost('/api/analyze');
      toast('✓ Analysis started — this may take a few minutes');
    } catch (e) {
      toast('Analyze failed: ' + e.message);
    }
    setTimeout(() => {
      btn.disabled = false;
      btn.textContent = '⚙ Analyze';
    }, 5000);
  }

  async function generateReport(gameId) {
    toast('Generating coach note — takes ~30 seconds...');
    try {
      await apiPost(`/api/coach/game/${gameId}`);
      const poll = setInterval(async () => {
        try {
          const data = await api(`/api/games/${gameId}`);
          if (data.journal) {
            clearInterval(poll);
            toast('✓ Coach note ready!');
            onReportReady(gameId);
          }
        } catch (e) {
          clearInterval(poll);
          toast('Polling failed: ' + e.message);
        }
      }, 5000);
      setTimeout(() => clearInterval(poll), 180000);
    } catch (e) {
      toast('Failed: ' + e.message);
    }
  }

  function bindEvents() {
    document.getElementById('btn-sync').addEventListener('click', triggerSync);
    document
      .getElementById('btn-analyze')
      .addEventListener('click', triggerAnalyze);
  }

  return {
    bindEvents,
    generateReport,
  };
}
