import { esc, fmt, mistakeTag } from '../ui.js';
import { createDomCache } from '../dom.js';

export function createMistakesView({ api, destroyChart, getStatsData, toast, charts }) {
  const dom = createDomCache();
  let rendered = false;

  async function load() {
    const statsData = getStatsData();
    if (!statsData) {
      toast('Stats still loading…');
      return;
    }
    if (rendered) return;
    rendered = true;

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

    try {
      const phaseData = await api('/api/mistakes/by-phase');
      destroyChart('phase');
      const ctxPhase = dom.byId('chart-phase').getContext('2d');
      charts.phase = new Chart(ctxPhase, {
        type: 'doughnut',
        data: {
          labels: phaseData.map((p) => p.phase),
          datasets: [
            {
              data: phaseData.map((p) => p.count),
              backgroundColor: ['#3fb950', '#58a6ff', '#d29922'],
              borderWidth: 0,
            },
          ],
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          plugins: {
            legend: {
              position: 'bottom',
              labels: { color: '#7d8590', font: { size: 11 } },
            },
          },
        },
      });
    } catch (e) {
      console.error('Phase chart failed:', e);
    }

    const recent = statsData.recent_games.slice().reverse();
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
                ? 'rgba(248,81,73,0.7)'
                : 'rgba(210,153,34,0.7)'
            ),
            borderRadius: 3,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { display: false } },
        scales: {
          x: {
            grid: { color: 'rgba(255,255,255,0.04)' },
            ticks: { color: '#7d8590', font: { size: 10 } },
          },
          y: {
            grid: { color: 'rgba(255,255,255,0.04)' },
            ticks: { color: '#7d8590', font: { size: 11 } },
          },
        },
      },
    });

    const games = await api('/api/games?limit=50&offset=0');
    const analyzedGames = games.slice(0, 20).filter((g) => g.analyzed === 1);
    const results = await Promise.allSettled(
      analyzedGames.map((g) => api(`/api/games/${g.id}/critical`))
    );
    const rows = results
      .map((r, i) => r.status === 'fulfilled'
        ? { ...r.value, game_date: analyzedGames[i].date }
        : null)
      .filter(Boolean);

    const tbody = dom.byId('critical-mistakes-body');
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
      '<tr><td colspan="6"><div class="empty">No data</div></td></tr>';
  }

  return {
    load,
  };
}
