import {
  colorBadge,
  esc,
  openingToneClass,
  openingToneTextClass,
  statePanelMarkup,
  tableStateRowMarkup,
  truncate,
} from '../ui.js';
import { createDomCache } from '../dom.js';
import { endpoints, normalize } from '../contracts.js';
import { createCache } from '../cache.js';
import { baseCartesianOptions, chartPalette } from '../charts.js';

export function createOpeningsView({ api, apiContract, apiDelete, apiPost, apiPut, charts, destroyChart, toast }) {
  const dom = createDomCache();
  const cache = createCache('api');
  let loaded = false;
  let loadedAtMs = 0;
  let selectedEco = '';
  let selectedColor = 'white';
  let openingsSummary = [];
  const openingsByColor = {
    white: [],
    black: [],
  };

  function prepColorFilter() {
    const value = dom.byId('repertoire-color-filter')?.value || '';
    return value === 'white' || value === 'black' ? value : '';
  }

  function setPanelState(id, message, kind = 'loading') {
    const el = dom.byId(id);
    if (!el) return;
    el.innerHTML = statePanelMarkup(message, { kind, compact: true });
  }
  function setChartMeta(id, text) {
    const el = dom.byId(id);
    if (el) el.textContent = text;
  }

  function confidenceLabel(games) {
    if (games >= 20) return 'High';
    if (games >= 10) return 'Medium';
    return 'Low';
  }

  function renderGenomeInsight(plyLabels, winPercentages) {
    const insightEl = dom.byId('genome-insight');
    if (!insightEl) return;
    if (!plyLabels.length || winPercentages.length < 2) {
      insightEl.textContent = 'Not enough depth to compute insight yet.';
      return;
    }
    let worst = null;
    for (let i = 1; i < winPercentages.length; i++) {
      const prev = Number(winPercentages[i - 1]) || 0;
      const next = Number(winPercentages[i]) || 0;
      const drop = next - prev;
      if (drop < 0 && (!worst || drop < worst.drop)) {
        worst = { fromPly: plyLabels[i - 1], toPly: plyLabels[i], prev, next, drop };
      }
    }
    if (!worst) {
      insightEl.textContent = 'No major drop detected in this line yet.';
      return;
    }
    insightEl.textContent = `Coaching insight: at ply ${worst.toPly}, win rate drops from ${worst.prev.toFixed(1)}% to ${worst.next.toFixed(1)}%.`;
  }

  function setLoadingCharts(isLoading) {
    ['chart-openings-white', 'chart-openings-black', 'opening-genome-chart'].forEach((id) => {
      const card = dom.byId(id)?.closest('.chart-card');
      if (!card) return;
      card.classList.toggle('is-loading', isLoading);
      if (isLoading) card.classList.remove('has-error');
    });
  }

  function setChartError(canvasId, hasError) {
    const card = dom.byId(canvasId)?.closest('.chart-card');
    if (!card) return;
    card.classList.toggle('has-error', !!hasError);
  }

  function renderRepertoire(lines) {
    const el = dom.byId('repertoire-list');
    if (!el) return;
    if (!lines.length) {
      el.innerHTML = statePanelMarkup('No repertoire lines saved yet. Add one opening line you actually play.', {
        actions: '<button class="btn btn-ghost" type="button" data-focus-repertoire-form>Add first line</button>',
      });
      return;
    }
    el.innerHTML = lines
      .map((line) => {
        const missed = Number(line.missed_count || 0);
        const trained = Number(line.training_count || 0);
        return `
          <article class="rounded-2xl border border-[var(--border)] bg-[var(--surface-2)] p-3 shadow-soft transition hover:-translate-y-0.5 hover:border-[rgba(63,185,80,0.28)]">
            <div class="flex items-start justify-between gap-3">
              <div class="min-w-0">
                <div class="mb-1 flex flex-wrap items-center gap-2">
                  ${colorBadge(line.color)}
                  <span class="badge badge-xs badge-ghost">${esc(line.eco || 'Custom')}</span>
                  <span class="badge badge-xs border border-[rgba(168,85,247,0.28)] bg-[rgba(168,85,247,0.12)] text-[var(--analytics)]">P${Number(line.priority || 3)}</span>
                </div>
                <h3 class="text-sm font-semibold text-[var(--text)]">${truncate(line.name, 56)}</h3>
              </div>
              <button class="btn btn-ghost btn-xs" type="button" data-repertoire-delete="${Number(line.id)}">Remove</button>
            </div>
            <p class="mt-2 text-xs leading-relaxed text-[var(--muted)]">${truncate(line.line_moves, 160)}</p>
            ${line.notes ? `<p class="mt-2 rounded-xl bg-[rgba(255,255,255,0.03)] px-3 py-2 text-xs text-[var(--text-soft)]">${truncate(line.notes, 160)}</p>` : ''}
            <div class="mt-3 flex flex-wrap items-center gap-2 text-xs text-[var(--muted)]">
              <span>${trained} recall${trained === 1 ? '' : 's'}</span>
              <span>•</span>
              <span>${missed} miss${missed === 1 ? '' : 'es'}</span>
              <span>•</span>
              <span>${line.last_trained_at ? `Last trained ${esc(line.last_trained_at)}` : 'Not trained yet'}</span>
            </div>
          </article>
        `;
      })
      .join('');
  }

  function renderWeakNodes(nodes) {
    const el = dom.byId('opening-weak-nodes');
    if (!el) return;
    if (!nodes.length) {
      el.innerHTML = statePanelMarkup('No weak opening node has enough data yet. Analyze more games to improve signal.', {
        icon: '♙',
      });
      return;
    }
    el.innerHTML = nodes
      .slice(0, 6)
      .map((node) => `
        <article class="rounded-2xl border border-[rgba(245,158,11,0.22)] bg-[rgba(245,158,11,0.06)] p-3">
          <div class="flex items-start justify-between gap-3">
            <div>
              <div class="mb-1 flex flex-wrap items-center gap-2">
                ${colorBadge(node.color)}
                <span class="badge badge-xs badge-warning">${esc(node.eco || 'ECO')}</span>
                <span class="badge badge-xs badge-ghost">Ply ${Number(node.ply || 0)}</span>
              </div>
              <div class="text-sm font-semibold text-[var(--text)]">${truncate(node.name, 48)}</div>
            </div>
            <button class="btn btn-ghost btn-xs" type="button"
              data-add-weak-node
              data-color="${esc(node.color)}"
              data-eco="${esc(node.eco || '')}"
              data-name="${esc(node.name || '')}"
              data-note="${esc(node.reason || '')}">
              Save line
            </button>
          </div>
          <p class="mt-2 text-xs leading-relaxed text-[var(--text-soft)]">${esc(node.reason)}</p>
          <div class="mt-3 grid grid-cols-3 gap-2 text-xs max-sm:grid-cols-1">
            <div class="rounded-xl bg-[rgba(255,255,255,0.035)] p-2">
              <div class="text-[var(--muted)]">Win rate</div>
              <div class="font-semibold ${openingToneTextClass(Number(node.win_pct || 0))}">${Number(node.win_pct || 0).toFixed(1)}%</div>
            </div>
            <div class="rounded-xl bg-[rgba(255,255,255,0.035)] p-2">
              <div class="text-[var(--muted)]">Drop</div>
              <div class="font-semibold text-warning">${Number(node.drop_pct || 0).toFixed(1)}%</div>
            </div>
            <div class="rounded-xl bg-[rgba(255,255,255,0.035)] p-2">
              <div class="text-[var(--muted)]">Issues</div>
              <div class="font-semibold text-error">${Number(node.issue_rate || 0).toFixed(1)}%</div>
            </div>
          </div>
        </article>
      `)
      .join('');
  }

  function renderOpeningTraining(training) {
    const el = dom.byId('opening-training-list');
    if (!el) return;
    const lines = training?.lines || [];
    if (!lines.length) {
      el.innerHTML = statePanelMarkup('Add repertoire lines to unlock opening recall training.', {
        actions: '<button class="btn btn-ghost" type="button" data-focus-repertoire-form>Add line</button>',
      });
      return;
    }
    const focus = training.focus
      ? `<div class="rounded-2xl border border-[rgba(168,85,247,0.24)] bg-[rgba(168,85,247,0.08)] p-3 text-xs text-[var(--text-soft)]">
          Focus today: ${esc(training.focus.eco || 'Opening')} at ply ${Number(training.focus.ply || 0)} · ${esc(training.focus.reason || 'Review this branch.')}
        </div>`
      : '';
    el.innerHTML =
      focus +
      lines
        .slice(0, 5)
        .map((line) => `
          <article class="rounded-2xl border border-[var(--border)] bg-[var(--surface-2)] p-3">
            <div class="flex items-start justify-between gap-2">
              <div class="min-w-0">
                <div class="text-sm font-semibold text-[var(--text)]">${truncate(line.name, 44)}</div>
                <div class="mt-1 text-xs text-[var(--muted)]">${esc(line.eco || 'Custom')} · ${esc(line.color)} · P${Number(line.priority || 3)}</div>
              </div>
            </div>
            <p class="mt-2 text-xs leading-relaxed text-[var(--text-soft)]">${truncate(line.line_moves, 140)}</p>
            <div class="mt-3 grid grid-cols-3 gap-2">
              <button class="btn btn-ghost btn-xs" type="button" data-training-result="remembered" data-line-id="${Number(line.id)}">Remembered</button>
              <button class="btn btn-ghost btn-xs" type="button" data-training-result="missed" data-line-id="${Number(line.id)}">Missed</button>
              <button class="btn btn-ghost btn-xs" type="button" data-training-result="skipped" data-line-id="${Number(line.id)}">Skip</button>
            </div>
          </article>
        `)
        .join('');
  }

  async function loadOpeningPrep(force = false) {
    if (force) cache.clear();
    const color = prepColorFilter();
    setPanelState('repertoire-list', 'Loading repertoire...', 'loading');
    setPanelState('opening-weak-nodes', 'Scanning weak nodes...', 'loading');
    setPanelState('opening-training-list', 'Preparing training queue...', 'loading');
    try {
      const [lines, weakNodes, training] = await Promise.all([
        cache.getOrSet(
          `openings:repertoire:${color || 'all'}`,
          () => apiContract(endpoints.openingRepertoire(color), normalize.openingRepertoire, 'openingRepertoire'),
          force ? 0 : 60000
        ),
        cache.getOrSet(
          `openings:weak-nodes:${color || 'all'}`,
          () => apiContract(endpoints.openingWeakNodes(12, color), normalize.openingWeakNodes, 'openingWeakNodes'),
          force ? 0 : 60000
        ),
        cache.getOrSet(
          `openings:training:${color || 'all'}`,
          () => apiContract(endpoints.openingTraining(color, 8), normalize.openingTraining, 'openingTraining'),
          force ? 0 : 60000
        ),
      ]);
      renderRepertoire(lines);
      renderWeakNodes(weakNodes);
      renderOpeningTraining(training);
    } catch (e) {
      console.error('Opening prep failed:', e);
      setPanelState('repertoire-list', 'Unable to load opening preparation data.', 'error');
      setPanelState('opening-weak-nodes', 'Unable to scan weak opening nodes.', 'error');
      setPanelState('opening-training-list', 'Unable to load opening training.', 'error');
      toast?.('Unable to load opening preparation.');
    }
  }

  function renderOpeningChart(canvasId, data) {
    destroyChart(canvasId);
    const ctx = dom.byId(canvasId).getContext('2d');
    charts[canvasId] = new Chart(ctx, {
      type: 'bar',
      data: {
        labels: data.map((o) => o.eco),
        datasets: [
          {
            label: 'Games',
            data: data.map((o) => o.games),
            backgroundColor: chartPalette.analyticsSoft,
            borderColor: chartPalette.analytics,
            borderWidth: 1,
            borderRadius: 6,
          },
          {
            label: 'Wins',
            data: data.map((o) => o.wins),
            backgroundColor: chartPalette.primarySoft,
            borderColor: chartPalette.primary,
            borderWidth: 1,
            borderRadius: 6,
          },
        ],
      },
      options: {
        ...baseCartesianOptions(),
        plugins: {
          legend: { display: true, position: 'top' },
        },
      },
    });
  }

  async function renderOpeningGenomeChart() {
    destroyChart('opening-genome');
    const genomeTitleEl = dom.byId('genome-title');
    const genomeTotalEl = dom.byId('genome-total-games');
    const genomeCanvas = dom.byId('opening-genome-chart');
    if (!genomeTitleEl || !genomeTotalEl || !genomeCanvas) return;

    if (!selectedEco || !selectedColor) {
      genomeTitleEl.textContent = 'Select an opening to view genome';
      genomeTotalEl.textContent = '';
      setGenomeStatus('');
      return;
    }

    try {
      const genomeData = await cache.getOrSet(
        `openings:genome:${selectedEco}:${selectedColor}`,
        () =>
          apiContract(
            endpoints.openingGenome(selectedEco, selectedColor),
            normalize.openingGenome,
            'openingGenome'
          ),
        120000
      );

      genomeTitleEl.textContent = `${selectedEco} Genome (${selectedColor})`;
      genomeTotalEl.textContent = `${genomeData.total_games} games`;
      
      const plyLabels = Object.keys(genomeData.winrate_by_ply).sort((a, b) => parseInt(a) - parseInt(b));
      const winPercentages = plyLabels.map(ply => genomeData.winrate_by_ply[ply].win_pct);
      renderGenomeInsight(plyLabels, winPercentages);

      const ctx = genomeCanvas.getContext('2d');
      charts['opening-genome'] = new Chart(ctx, {
        type: 'line',
        data: {
          labels: plyLabels.map(p => `Ply ${p}`),
          datasets: [
            {
              label: 'Win %',
              data: winPercentages,
              borderColor: chartPalette.analytics,
              backgroundColor: chartPalette.analyticsSoft,
              fill: true,
              tension: 0.36,
              borderWidth: 2,
              pointRadius: 0,
              pointHoverRadius: 4,
              pointBackgroundColor: chartPalette.analytics,
            },
          ],
        },
        options: {
          ...baseCartesianOptions({ min: 0, max: 100, percent: true }),
          plugins: {
            legend: { display: false },
            tooltip: {
              callbacks: {
                label(context) {
                  return `Win rate: ${Number(context.parsed?.y || 0).toFixed(1)}%`;
                },
              },
            },
          },
        },
      });
      setChartError('opening-genome-chart', false);
      setGenomeStatus('');
    } catch (e) {
      console.error('Opening genome chart failed:', e);
      genomeTitleEl.textContent = 'Unable to load opening genome';
      genomeTotalEl.textContent = '';
      destroyChart('opening-genome');
      setChartError('opening-genome-chart', true);
      setGenomeStatus('Unable to load opening genome.', true);
      const insightEl = dom.byId('genome-insight');
      if (insightEl) insightEl.textContent = 'Genome insight is unavailable right now.';
      toast?.('Unable to load opening genome.');
    }
  }

  function setGenomeStatus(message = '', showRetry = false) {
    const statusEl = dom.byId('opening-genome-status');
    if (!statusEl) return;
    if (!message) {
      statusEl.hidden = true;
      statusEl.innerHTML = '';
      return;
    }
    statusEl.hidden = false;
    statusEl.innerHTML = statePanelMarkup(message, {
      kind: 'error',
      compact: true,
      actions: showRetry ? '<button class="btn btn-ghost" type="button" data-retry-genome>Retry</button>' : '',
    });
  }

  async function load(force = false) {
    const staleMs = 120000;
    if (loaded && !force && Date.now() - loadedAtMs < staleMs) return;
    loaded = true;
    setChartMeta('chart-openings-white-meta', 'Refreshing…');
    setChartMeta('chart-openings-black-meta', 'Refreshing…');
    setLoadingCharts(true);
    const genomeTitleEl = dom.byId('genome-title');
    const genomeTotalEl = dom.byId('genome-total-games');
    if (genomeTitleEl) genomeTitleEl.textContent = 'Building opening workspace…';
    if (genomeTotalEl) genomeTotalEl.textContent = 'Preparing summary and genome';
    const insightEl = dom.byId('genome-insight');
    if (insightEl) insightEl.textContent = 'Loading genome insight...';
    setGenomeStatus('');
    loadOpeningPrep(force);
    const tbody = dom.byId('openings-body');
    tbody.innerHTML = tableStateRowMarkup('Loading openings...', 6, { kind: 'loading' });
    let summary;
    try {
      summary = await cache.getOrSet(
        'openings:summary:v1',
        () => apiContract(endpoints.openingsSummary(500), normalize.openingsSummary, 'openingsSummary'),
        60000
      );
    } catch (e) {
      setLoadingCharts(false);
      setChartError('chart-openings-white', true);
      setChartError('chart-openings-black', true);
      setChartMeta('chart-openings-white-meta', 'Unavailable');
      setChartMeta('chart-openings-black-meta', 'Unavailable');
      tbody.innerHTML = `
        ${tableStateRowMarkup('Unable to load openings.', 6, {
          kind: 'error',
          actions: '<button class="btn btn-ghost" type="button" data-retry-openings>Retry</button>',
        })}
      `;
      toast?.('Unable to load openings.');
      return;
    }

    openingsSummary = summary
      .map((o) => ({
        eco: o.eco,
        name: o.name,
        color: o.color,
        games: Number(o.games) || 0,
        wins: Number(o.wins) || 0,
        win_pct: Number(o.win_pct) || 0,
      }))
      .sort((a, b) => b.games - a.games);

    openingsByColor.white = openingsSummary.filter((o) => o.color === 'white');
    openingsByColor.black = openingsSummary.filter((o) => o.color === 'black');

    const whiteTop = openingsByColor.white.slice(0, 6);
    const blackTop = openingsByColor.black.slice(0, 6);

    renderOpeningChart('chart-openings-white', whiteTop);
    renderOpeningChart('chart-openings-black', blackTop);
    setChartError('chart-openings-white', false);
    setChartError('chart-openings-black', false);
    setChartMeta('chart-openings-white-meta', `Updated • ${whiteTop.length} ECOs`);
    setChartMeta('chart-openings-black-meta', `Updated • ${blackTop.length} ECOs`);
    setLoadingCharts(false);

    // Populate the dropdown for opening selection
    const ecoSelect = dom.byId('select-eco-genome');
    if (ecoSelect) {
      ecoSelect.innerHTML = '<option value="">-- Select ECO --</option>';
      openingsSummary.forEach((o) => {
        const option = document.createElement('option');
        option.value = o.eco;
        option.textContent = `${o.eco} - ${truncate(o.name, 30)}`;
        ecoSelect.appendChild(option);
      });
    }

    if (!openingsSummary.length) {
      loadedAtMs = Date.now();
      tbody.innerHTML = tableStateRowMarkup('No analyzed openings available yet.', 6, {
        actions: '<button class="btn btn-ghost" type="button" data-run-analysis-openings>Run Analysis</button>',
      });
      return;
    }
    tbody.innerHTML = openingsSummary
      .slice(0, 30)
      .map((o) => {
        const winPct = o.win_pct.toFixed(0);
        const confidence = confidenceLabel(o.games);
        const confidenceTone =
          confidence === 'High'
            ? 'badge-success'
            : confidence === 'Medium'
              ? 'badge-warning'
              : 'badge-ghost';
        return `
      <tr>
        <td>
          <div class="flex items-center gap-2">
            <div class="mini-board-thumb w-8 shrink-0" aria-hidden="true">${'<span></span>'.repeat(16)}</div>
            <span class="cell-code-strong">${esc(o.eco)}</span>
          </div>
        </td>
        <td>${truncate(o.name, 40)}</td>
        <td>${colorBadge(o.color)}</td>
        <td>${o.games} <span class="badge badge-xs ${confidenceTone} ml-1">${confidence}</span></td>
        <td>${o.wins}</td>
        <td>
          <div class="flex items-center gap-2">
            <span class="min-w-10 text-right text-xs font-medium ${openingToneTextClass(Number(winPct))}">${winPct}%</span>
            <div class="mastery-bar grow">
              <progress class="progress-meter ${openingToneClass(Number(winPct))}" max="100" value="${winPct}"></progress>
            </div>
          </div>
        </td>
      </tr>
    `;
      })
      .join('');

      // Initial render of the genome chart if an ECO is pre-selected or default
      if (selectedEco && selectedColor) {
        renderOpeningGenomeChart();
      }
      loadedAtMs = Date.now();
  }

  function bindEvents() {
    dom.byId('select-eco-genome')?.addEventListener('change', (e) => {
      selectedEco = e.target.value;
      renderOpeningGenomeChart();
    });

    dom.byId('select-color-genome')?.addEventListener('change', (e) => {
      selectedColor = e.target.value;
      renderOpeningGenomeChart();
    });
    dom.byId('repertoire-color-filter')?.addEventListener('change', () => {
      loadOpeningPrep(true);
    });
    dom.byId('repertoire-form')?.addEventListener('submit', async (event) => {
      event.preventDefault();
      if (!apiPost) return;
      const payload = {
        color: dom.byId('repertoire-color')?.value || 'white',
        eco: dom.byId('repertoire-eco')?.value || null,
        name: dom.byId('repertoire-name')?.value || '',
        line_moves: dom.byId('repertoire-line')?.value || '',
        notes: dom.byId('repertoire-notes')?.value || null,
        priority: Number(dom.byId('repertoire-priority')?.value || 3),
      };
      try {
        await apiPost(endpoints.openingRepertoire(), payload);
        event.target.reset();
        const priority = dom.byId('repertoire-priority');
        if (priority) priority.value = '3';
        cache.clear();
        await loadOpeningPrep(true);
        toast?.('Repertoire line saved.');
      } catch (e) {
        console.error('Create repertoire line failed:', e);
        toast?.(e.message || 'Unable to save repertoire line.');
      }
    });
    dom.byId('repertoire-list')?.addEventListener('click', async (event) => {
      const focusBtn = event.target.closest('[data-focus-repertoire-form]');
      if (focusBtn) {
        dom.byId('repertoire-name')?.focus();
        return;
      }
      const deleteBtn = event.target.closest('[data-repertoire-delete]');
      if (!deleteBtn || !apiDelete) return;
      const lineId = Number(deleteBtn.dataset.repertoireDelete || 0);
      if (!lineId) return;
      try {
        await apiDelete(endpoints.openingRepertoireItem(lineId));
        cache.clear();
        await loadOpeningPrep(true);
        toast?.('Repertoire line removed.');
      } catch (e) {
        console.error('Delete repertoire line failed:', e);
        toast?.(e.message || 'Unable to remove repertoire line.');
      }
    });
    dom.byId('opening-weak-nodes')?.addEventListener('click', (event) => {
      const btn = event.target.closest('[data-add-weak-node]');
      if (!btn) return;
      const color = dom.byId('repertoire-color');
      const eco = dom.byId('repertoire-eco');
      const name = dom.byId('repertoire-name');
      const notes = dom.byId('repertoire-notes');
      const line = dom.byId('repertoire-line');
      if (color) color.value = btn.dataset.color || 'white';
      if (eco) eco.value = btn.dataset.eco || '';
      if (name) name.value = `${btn.dataset.eco || 'Opening'} repair line`;
      if (notes) notes.value = `${btn.dataset.name || ''}: ${btn.dataset.note || 'Review this weak node.'}`.trim();
      if (line) {
        line.placeholder = 'Add the exact repair line you want to memorize';
        line.focus();
      }
    });
    dom.byId('opening-training-list')?.addEventListener('click', async (event) => {
      const focusBtn = event.target.closest('[data-focus-repertoire-form]');
      if (focusBtn) {
        dom.byId('repertoire-name')?.focus();
        return;
      }
      const resultBtn = event.target.closest('[data-training-result]');
      if (!resultBtn || !apiPost) return;
      const lineId = Number(resultBtn.dataset.lineId || 0);
      const result = resultBtn.dataset.trainingResult;
      if (!lineId || !result) return;
      try {
        await apiPost(endpoints.openingTrainingResult(), { line_id: lineId, result });
        cache.clear();
        await loadOpeningPrep(true);
        toast?.(`Opening recall marked: ${result}.`);
      } catch (e) {
        console.error('Opening training result failed:', e);
        toast?.(e.message || 'Unable to record opening training.');
      }
    });
    dom.byId('btn-refresh-opening-training')?.addEventListener('click', () => {
      cache.clear();
      loadOpeningPrep(true);
    });
    dom.byId('openings-body')?.addEventListener('click', (event) => {
      const btn = event.target.closest('[data-retry-openings]');
      if (btn) {
        cache.clear();
        load(true);
        return;
      }
      const analyzeBtn = event.target.closest('[data-run-analysis-openings]');
      if (!analyzeBtn) return;
      document.getElementById('btn-analyze')?.click();
    });
    dom.byId('btn-refresh-openings')?.addEventListener('click', () => {
      cache.clear();
      load(true);
    });
    dom.byId('opening-genome-status')?.addEventListener('click', (event) => {
      const btn = event.target.closest('[data-retry-genome]');
      if (!btn) return;
      renderOpeningGenomeChart();
    });
    document.addEventListener('data:games-updated', () => {
      cache.clear();
      loaded = false;
      load(true);
    });
  }

  return {
    bindEvents,
    load,
  };
}
