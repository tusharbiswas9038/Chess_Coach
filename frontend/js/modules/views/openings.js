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

export function createOpeningsView({ api, apiContract, charts, destroyChart, toast }) {
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
            backgroundColor: chartPalette.blueSoft,
            borderColor: chartPalette.blue,
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
              borderColor: chartPalette.blue,
              backgroundColor: chartPalette.blueSoft,
              fill: true,
              tension: 0.36,
              borderWidth: 2,
              pointRadius: 0,
              pointHoverRadius: 4,
              pointBackgroundColor: chartPalette.blue,
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
    setLoadingCharts(true);
    const genomeTitleEl = dom.byId('genome-title');
    const genomeTotalEl = dom.byId('genome-total-games');
    if (genomeTitleEl) genomeTitleEl.textContent = 'Building opening workspace…';
    if (genomeTotalEl) genomeTotalEl.textContent = 'Preparing summary and genome';
    const insightEl = dom.byId('genome-insight');
    if (insightEl) insightEl.textContent = 'Loading genome insight...';
    setGenomeStatus('');
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
        <td class="cell-code-strong">${esc(o.eco)}</td>
        <td>${truncate(o.name, 40)}</td>
        <td>${colorBadge(o.color)}</td>
        <td>${o.games} <span class="badge badge-xs ${confidenceTone} ml-1">${confidence}</span></td>
        <td>${o.wins}</td>
        <td>
          <div class="flex items-center gap-2">
            <span class="min-w-10 text-right text-xs font-medium ${openingToneTextClass(Number(winPct))}">${winPct}%</span>
            <div class="progress-bar grow">
              <progress
                class="progress-meter progress h-2 w-full ${openingToneClass(Number(winPct))}"
                max="100"
                value="${winPct}"
              ></progress>
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
