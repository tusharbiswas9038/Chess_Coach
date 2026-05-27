// dashboard-insights.js
//
// Renders the "Insights Explorer" panel: trend deltas (14-day), filtered
// slices for a chosen dimension (color/phase/opening_family/opponent/result),
// and the dimension-select handler that re-renders slices on change.
//
// Owns its own snapshot fetch (passed in via fetchInsights) so the dimension
// dropdown can refresh without round-tripping through dashboard.js.

import { esc, statePanelMarkup } from '../ui.js';

const TREND_WINDOW_DAYS = 14;
const SLICE_LIMIT = 8;

function trendLabel(metric) {
  const labels = {
    win_rate: 'Win rate',
    mistakes_per_game: 'Mistakes / game',
    blunders_per_game: 'Blunders / game',
    games: 'Games played',
  };
  return labels[metric] || String(metric || '').replaceAll('_', ' ');
}

function formatTrendValue(metric, value) {
  const n = Number(value || 0);
  if (metric === 'win_rate') return `${(n * 100).toFixed(1)}%`;
  if (metric === 'games') return n.toFixed(0);
  return n.toFixed(2);
}

function trendTone(direction, metric) {
  const isReducedSeries = metric === 'mistakes_per_game' || metric === 'blunders_per_game';
  if (direction === 'up') return isReducedSeries ? 'text-error' : 'text-success';
  if (direction === 'down') return isReducedSeries ? 'text-success' : 'text-warning';
  return 'text-[var(--muted)]';
}

function sliceTone(winPct) {
  if (winPct >= 50) return { text: 'text-success', fill: 'progress-fill-good' };
  if (winPct >= 35) return { text: 'text-warning', fill: 'progress-fill-warn' };
  return { text: 'text-error', fill: 'progress-fill-bad' };
}

function renderTrendCard(item) {
  const tone = trendTone(item.direction || 'flat', item.metric);
  return `
    <article class="rounded-2xl border border-[var(--border)] bg-[var(--surface-2)] p-3">
      <div class="flex items-start justify-between gap-2">
        <div>
          <div class="text-xs uppercase tracking-kicker text-[var(--muted)]">${TREND_WINDOW_DAYS} day trend</div>
          <div class="mt-1 text-sm font-semibold text-[var(--text)]">${esc(trendLabel(item.metric))}</div>
        </div>
        <span class="badge badge-xs badge-ghost">${esc(item.confidence || 'low')}</span>
      </div>
      <div class="mt-3 flex items-end justify-between gap-3">
        <div class="text-2xl font-bold ${tone}">${esc(formatTrendValue(item.metric, item.current_value))}</div>
        <div class="text-right text-xs text-[var(--muted)]">
          <div>Δ ${esc(formatTrendValue(item.metric, item.delta_value))}</div>
          <div>${Number(item.sample_size || 0)} games</div>
        </div>
      </div>
    </article>
  `;
}

function renderSliceCard(item) {
  const winPct = Number(item.win_pct || 0);
  const tone = sliceTone(winPct);
  return `
    <article class="rounded-2xl border border-[var(--border)] bg-[var(--surface-2)] p-3">
      <div class="flex items-start justify-between gap-3">
        <div class="min-w-0">
          <div class="text-sm font-semibold text-[var(--text)]">${esc(String(item.bucket || 'unknown').toUpperCase())}</div>
          <div class="mt-1 text-xs text-[var(--muted)]">${Number(item.games || 0)} games · ${Number(item.mistakes || 0)} mistakes · ${Number(item.blunders || 0)} severe</div>
        </div>
        <span class="badge badge-xs badge-ghost">${esc(item.confidence || 'low')}</span>
      </div>
      <div class="mt-3 flex items-center gap-2">
        <span class="min-w-12 text-right text-xs font-semibold ${tone.text}">${winPct.toFixed(1)}%</span>
        <progress class="progress-meter ${tone.fill} grow" max="100" value="${winPct}"></progress>
      </div>
    </article>
  `;
}

export function createDashboardInsightsView({ dom, fetchInsights }) {
  function renderTrends(insights) {
    const trendEl = dom.byId('trend-deltas');
    if (!trendEl) return;
    const trends = (insights?.trends || []).filter(
      (item) => Number(item.window_days) === TREND_WINDOW_DAYS
    );
    trendEl.innerHTML = trends.length
      ? trends.map(renderTrendCard).join('')
      : statePanelMarkup('No trend snapshot yet.');
  }

  function renderSlices(insights) {
    const sliceEl = dom.byId('insight-slices');
    if (!sliceEl) return;
    const dimension = dom.byId('insights-dimension')?.value || 'color';
    const slices = (insights?.slices || [])
      .filter((item) => item.dimension === dimension)
      .sort((a, b) => Number(b.games || 0) - Number(a.games || 0))
      .slice(0, SLICE_LIMIT);
    if (!slices.length) {
      sliceEl.innerHTML = statePanelMarkup('No slice data available for this dimension.');
      return;
    }
    sliceEl.innerHTML = slices.map(renderSliceCard).join('');
  }

  function render(insights) {
    renderTrends(insights);
    renderSlices(insights);
  }

  function bindEvents() {
    dom.byId('insights-dimension')?.addEventListener('change', async () => {
      // Re-render slices using the freshest snapshot. Trends don't change
      // on dimension switch, so we skip rebuilding them here.
      try {
        const insights = await fetchInsights();
        renderSlices(insights);
      } catch (err) {
        // Fail quietly — the empty state covers it on next render.
        console.warn('insights dimension refresh failed:', err);
      }
    });
  }

  return {
    render,
    renderTrends,
    renderSlices,
    bindEvents,
  };
}
