import { esc, fmt, mistakeTag, tableStateRowMarkup } from '../ui.js';
import { createDomCache } from '../dom.js';
import { endpoints } from '../contracts.js';
import { createCache } from '../cache.js';
import { baseCartesianOptions, chartPalette, doughnutOptions } from '../charts.js';

export function createMistakesView({ api, destroyChart, getStatsData, toast, charts }) {
  const dom = createDomCache();
  const cache = createCache('api');
  let rendered = false;
  let activePhase = '';
  const heatmapSquareNodes = new Map();
  let heatmapOrientation = null;

  function setLoadingSections(isLoading) {
    ['mistakes-card-phase', 'mistakes-card-trend', 'mistakes-card-heatmap', 'mistakes-card-critical', 'mistakes-card-motifs']
      .forEach((id) => {
        const el = dom.byId(id);
        if (!el) return;
        el.classList.toggle('is-loading', isLoading);
        if (isLoading) el.classList.remove('has-error');
      });
  }

  function setSectionError(id, hasError) {
    const el = dom.byId(id);
    if (!el) return;
    el.classList.toggle('has-error', !!hasError);
  }

  function phaseLabel(phase) {
    if (!phase) return 'All Phases';
    return phase.charAt(0).toUpperCase() + phase.slice(1);
  }

  function renderPhaseTabs() {
    dom.queryAll('#mistakes-phase-tabs [data-phase]').forEach((btn) => {
      btn.classList.toggle('active', (btn.dataset.phase || '') === activePhase);
    });
  }

  function renderInlineStatus(message = '', showRetry = false) {
    const view = dom.byId('view-mistakes');
    if (!view) return;
    let panel = dom.byId('mistakes-inline-status');
    if (!message) {
      panel?.remove();
      return;
    }
    if (!panel) {
      panel = document.createElement('div');
      panel.id = 'mistakes-inline-status';
      panel.className = 'card card-pad';
      view.prepend(panel);
    }
    panel.innerHTML = `
      <div class="empty empty-compact">
        <div>${esc(message)}</div>
        ${showRetry ? '<button class="btn btn-ghost space-top-sm" type="button" data-retry-mistakes>Retry</button>' : ''}
        <button class="btn btn-ghost space-top-sm" type="button" data-run-analysis-mistakes>Run Analysis</button>
      </div>
    `;
  }

  const files = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];
  const ranks = ['1', '2', '3', '4', '5', '6', '7', '8'];

  function heatmapLevel(count, maxCount) {
    if (!maxCount || count <= 0) return 0;
    const ratio = Math.min(1, count / maxCount);
    return Math.max(1, Math.min(5, Math.ceil(ratio * 5)));
  }


  function ensureHeatmapGrid(heatmapBoardEl, isWhite) {
    const orientation = isWhite ? 'white' : 'black';
    if (heatmapSquareNodes.size && heatmapOrientation === orientation) return;
    heatmapSquareNodes.clear();
    heatmapBoardEl.innerHTML = '';
    heatmapOrientation = orientation;
    for (let rIdx = 0; rIdx < 8; rIdx++) {
      const rank = isWhite ? ranks[7 - rIdx] : ranks[rIdx];
      for (let fIdx = 0; fIdx < 8; fIdx++) {
        const file = isWhite ? files[fIdx] : files[7 - fIdx];
        const squareName = file + rank;
        const squareEl = document.createElement('div');
        squareEl.className = 'heatmap-square heatmap-level-0';
        squareEl.dataset.square = squareName;
        heatmapSquareNodes.set(squareName, squareEl);
        heatmapBoardEl.appendChild(squareEl);
      }
    }
  }

  async function renderBlunderHeatmap(heatmapData) {
    const heatmapBoardEl = dom.byId('heatmap-board');
    if (!heatmapBoardEl) return;
    const counts = Object.values(heatmapData);
    const maxCount = counts.length ? Math.max(...counts) : 0;

    // Determine player color for orientation (assuming 'white' is default for dashboard view)
    const playerColor = getStatsData()?.profile?.color || 'white'; 
    const isWhite = playerColor === 'white';
    ensureHeatmapGrid(heatmapBoardEl, isWhite);

    for (const [squareName, squareEl] of heatmapSquareNodes.entries()) {
      const count = heatmapData[squareName] || 0;
      const level = heatmapLevel(count, maxCount);
      squareEl.className = `heatmap-square heatmap-level-${level}`;
      squareEl.title = `${squareName}: ${count} blunders`;
    }
  }

  async function load(force = false) {
    const statsData = getStatsData();
    if (!statsData) {
      toast('Stats still loading…');
      return;
    }
    if (rendered && !force) return;
    rendered = true;
    renderInlineStatus('');
    renderPhaseTabs();
    setLoadingSections(true);
    let hadSectionError = false;

    const breakdown = statsData.mistake_breakdown;
    const byType = {};
    breakdown.forEach((m) => {
      byType[m.type] = m.count;
    });

    dom.byId('m-blunders').textContent = (
      byType.blunder || 0
    ).toLocaleString();
    dom.byId('m-hanging').textContent = (
      byType.hanging_piece || 0
    ).toLocaleString();
    dom.byId('m-mistakes').textContent = (
      byType.mistake || 0
    ).toLocaleString();

    const tbody = dom.byId('critical-mistakes-body');
    tbody.innerHTML = tableStateRowMarkup('Loading critical mistakes...', 6, { kind: 'loading' });

    const [phaseResult, heatmapResult, criticalResult, motifsResult] = await Promise.allSettled([
      cache.getOrSet(`mistakes:by-phase:${activePhase || 'all'}`, () => api(endpoints.mistakesByPhase(activePhase)), 60000),
      cache.getOrSet(`mistakes:blunder-heatmap:${activePhase || 'all'}`, () => api(endpoints.blunderHeatmap(activePhase)), 60000),
      cache.getOrSet(`mistakes:critical:200:${activePhase || 'all'}`, () => api(endpoints.criticalMistakes(200, activePhase)), 60000),
      cache.getOrSet(`mistakes:motifs:3:${activePhase || 'all'}`, () => api(endpoints.weeklyMotifs(3, activePhase)), 60000),
    ]);

    if (phaseResult.status === 'fulfilled') {
      const phaseData = phaseResult.value;
      destroyChart('phase');
      const ctxPhase = dom.byId('chart-phase').getContext('2d');
      charts.phase = new Chart(ctxPhase, {
        type: 'doughnut',
        data: {
          labels: phaseData.map((p) => p.phase),
          datasets: [
            {
              data: phaseData.map((p) => p.count),
              backgroundColor: [chartPalette.primarySoft, chartPalette.blueSoft, chartPalette.warningSoft],
              borderColor: [chartPalette.primary, chartPalette.blue, chartPalette.warning],
              borderWidth: 1,
            },
          ],
        },
        options: doughnutOptions(),
      });
      setSectionError('mistakes-card-phase', false);
    } else {
      console.error('Phase chart failed:', phaseResult.reason);
      toast('Unable to load phase breakdown.');
      setSectionError('mistakes-card-phase', true);
      hadSectionError = true;
    }

    if (motifsResult.status === 'fulfilled') {
      const motifs = motifsResult.value || [];
      const list = dom.byId('mistakes-motifs-list');
      list.innerHTML = motifs.length
        ? motifs
          .map(
            (m) => `
              <div class="coach-context-row">
                <span>${m.type.replace('_', ' ')} · ${phaseLabel(m.phase)}</span>
                <strong>${m.count}x</strong>
              </div>
            `
          )
          .join('')
        : '<div class="empty empty-compact">No recurring motifs in the last 7 days.</div>';
      setSectionError('mistakes-card-motifs', false);
    } else {
      setSectionError('mistakes-card-motifs', true);
      hadSectionError = true;
    }

    if (heatmapResult.status === 'fulfilled') {
      renderBlunderHeatmap(heatmapResult.value);
      setSectionError('mistakes-card-heatmap', false);
    } else {
      console.error('Blunder heatmap failed:', heatmapResult.reason);
      toast('Unable to load blunder heatmap.');
      setSectionError('mistakes-card-heatmap', true);
      hadSectionError = true;
    }

    const recent = activePhase
      ? (() => {
        const grouped = new Map();
        (criticalResult.status === 'fulfilled' ? criticalResult.value || [] : []).forEach((row) => {
          const d = row.game_date?.slice(0, 10) || 'Unknown';
          grouped.set(d, (grouped.get(d) || 0) + 1);
        });
        return [...grouped.entries()]
          .sort((a, b) => a[0].localeCompare(b[0]))
          .map(([date, mistake_count]) => ({ date, mistake_count }));
      })()
      : statsData.recent_games.slice().reverse();
    destroyChart('blunder-trend');
    const ctxTrend = dom.byId('chart-blunder-trend').getContext('2d');
    charts['blunder-trend'] = new Chart(ctxTrend, {
      type: 'bar',
      data: {
        labels: recent.map((g) => fmt(g.date)),
        datasets: [
          {
            label: 'Mistakes',
            data: recent.map((g) => g.mistake_count),
            backgroundColor: recent.map((g) =>
              g.mistake_count > 10
                ? chartPalette.errorSoft
                : chartPalette.warningSoft
            ),
            borderColor: recent.map((g) =>
              g.mistake_count > 10 ? chartPalette.error : chartPalette.warning
            ),
            borderWidth: 1,
            borderRadius: 6,
          },
        ],
      },
      options: baseCartesianOptions(),
    });
    setSectionError('mistakes-card-trend', false);

    if (criticalResult.status !== 'fulfilled') {
      console.error('Critical mistakes fetch failed:', criticalResult.reason);
      tbody.innerHTML = tableStateRowMarkup('Unable to load critical mistakes.', 6, {
        kind: 'error',
      });
      setSectionError('mistakes-card-critical', true);
      hadSectionError = true;
      renderInlineStatus('Some mistake insights failed to load.', true);
      setLoadingSections(false);
      return;
    }
    setSectionError('mistakes-card-critical', false);
    const rows = criticalResult.value || [];

    tbody.innerHTML =
      rows
        .map(
          (m) => `
    <tr>
      <td>${fmt(m.game_date)}</td>
      <td>${mistakeTag(m.type)}</td>
      <td class="cell-phase">${m.phase || '—'}</td>
      <td class="cell-code text-error">${esc(m.played_move)}</td>
      <td class="cell-code text-success">${esc(m.best_move)}</td>
      <td class="cell-strong text-error">−${m.eval_loss}</td>
    </tr>
  `
        )
        .join('') ||
      `
        ${tableStateRowMarkup('No critical mistakes available yet.', 6)}
        <tr><td colspan="6"><div class="empty empty-compact"><button class="btn btn-ghost" type="button" data-run-analysis-mistakes>Run Analysis</button></div></td></tr>
      `;

    if (hadSectionError) {
      renderInlineStatus('Some mistake insights failed to load.', true);
    }
    setLoadingSections(false);
  }

  function bindEvents() {
    dom.byId('view-mistakes')?.addEventListener('click', (event) => {
      const phaseBtn = event.target.closest('[data-phase]');
      if (phaseBtn && phaseBtn.closest('#mistakes-phase-tabs')) {
        activePhase = phaseBtn.dataset.phase || '';
        rendered = false;
        cache.clear();
        load(true);
        return;
      }
      const btn = event.target.closest('[data-retry-mistakes]');
      if (btn) {
        cache.clear();
        load(true);
        return;
      }
      const analyzeBtn = event.target.closest('[data-run-analysis-mistakes]');
      if (!analyzeBtn) return;
      document.getElementById('btn-analyze')?.click();
    });
    document.addEventListener('data:games-updated', () => {
      cache.clear();
      rendered = false;
      load(true);
    });
  }

  return {
    bindEvents,
    load,
  };
}
