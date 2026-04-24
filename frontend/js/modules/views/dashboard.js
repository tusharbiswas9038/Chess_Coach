import {
  colorBadge,
  esc,
  fmt,
  mistakeCountClass,
  resultBadge,
  setBadgeCount,
  truncate,
} from '../ui.js';

export function createDashboardView({
  api,
  charts,
  destroyChart,
  getStatsData,
  onOpenGame,
  onOpenGames,
  onStatsLoaded,
  setStatsData,
  toast,
}) {
  function updateDashboardFocus(statsData) {
    const dueCount = statsData?.drills_due || 0;
    const pending = statsData?.games?.pending || 0;
    const hRate = (statsData?.hanging_piece_rate || 0) * 100;
    const bpg = statsData?.blunders_per_game || 0;
    const weeklyWinRate = statsData?.weekly_stats?.[0]?.win_pct;

    let title = 'Review recent critical moments';
    let text =
      'Your analysis backlog is clear. Use the latest critical mistake as the warm-up before playing again.';

    if (dueCount > 0) {
      title = `${dueCount} drill${dueCount === 1 ? '' : 's'} due today`;
      text =
        hRate >= 40
          ? `Piece safety is still costing games in ${hRate.toFixed(1)}% of analyzed games. Clear the drill queue before adding more volume.`
          : 'Start with your own recurring positions, then move back into game review.';
    } else if (hRate >= 40) {
      title = 'Piece safety first';
      text = `You are still leaving pieces en prise in ${hRate.toFixed(1)}% of analyzed games. Review the latest critical mistake before you queue again.`;
    } else if (bpg >= 3) {
      title = 'Reduce one blunder this week';
      text = `Your current blunder rate is ${bpg.toFixed(1)} per game. Focus on one slower blunder-check routine before every move.`;
    } else if (pending > 0) {
      title = `Analyze ${pending} pending game${pending === 1 ? '' : 's'}`;
      text = 'Your next improvement signal is waiting in the backlog. Run analysis and then review the newest report.';
    }

    document.getElementById('focus-primary-value').textContent = title;
    document.getElementById('focus-primary-text').textContent = text;
    document.getElementById('focus-drills-due').textContent = dueCount;
    document.getElementById('focus-games-pending').textContent = pending;
    document.getElementById('focus-weekly-form').textContent =
      weeklyWinRate != null ? `${weeklyWinRate}%` : '—';
  }

  function renderWinRateChart(statsData) {
    destroyChart('winrate');
    const weeks = (statsData.weekly_stats || []).slice().reverse();
    const ctx = document.getElementById('chart-winrate').getContext('2d');
    charts.winrate = new Chart(ctx, {
      type: 'line',
      data: {
        labels: weeks.map((w) => (w.week_start ? w.week_start.slice(5) : '')),
        datasets: [
          {
            label: 'Win %',
            data: weeks.map((w) => w.win_pct),
            borderColor: '#3fb950',
            backgroundColor: 'rgba(63,185,80,0.1)',
            fill: true,
            tension: 0.3,
            pointRadius: 4,
            pointBackgroundColor: '#3fb950',
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
            ticks: { color: '#7d8590', font: { size: 11 } },
          },
          y: {
            grid: { color: 'rgba(255,255,255,0.04)' },
            ticks: { color: '#7d8590', font: { size: 11 } },
            min: 0,
            max: 100,
          },
        },
      },
    });
  }

  function renderMistakeBreakdownChart(statsData) {
    destroyChart('mistakes');
    const data = statsData.mistake_breakdown || [];
    const ctx = document.getElementById('chart-mistakes').getContext('2d');
    charts.mistakes = new Chart(ctx, {
      type: 'doughnut',
      data: {
        labels: data.map((m) => m.type.replace('_', ' ')),
        datasets: [
          {
            data: data.map((m) => m.count),
            backgroundColor: ['#f85149', '#d29922', '#58a6ff'],
            borderWidth: 0,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: {
            position: 'right',
            labels: { color: '#7d8590', font: { size: 11 }, padding: 12 },
          },
        },
      },
    });
  }

  function reviewLatestGame() {
    const latest = getStatsData()?.recent_games?.[0];
    if (latest) {
      onOpenGame(latest.id);
      return;
    }
    onOpenGames();
  }

  async function loadStats() {
    let statsData;
    try {
      statsData = await api('/api/stats');
      setStatsData(statsData);
    } catch (e) {
      toast('Failed to load stats: ' + e.message);
      return;
    }

    const p = statsData.profile;
    const dueCount = statsData.drills_due;
    setBadgeCount(document.getElementById('drill-badge'), dueCount);

    document.getElementById('sidebar-rating').textContent =
      p.current_rating || '—';
    updateDashboardFocus(statsData);
    document.getElementById('btn-review-latest').disabled =
      !statsData.recent_games.length;

    onStatsLoaded();

    const hRate = (statsData.hanging_piece_rate * 100).toFixed(1);
    const bpg = statsData.blunders_per_game;
    const analyzed = statsData.games.analyzed;
    const total = statsData.games.total;

    document.getElementById('kpi-grid').innerHTML = `
    <div class="kpi-card">
      <div class="kpi-label">Games Analyzed</div>
      <div class="kpi-value kpi-blue">${analyzed.toLocaleString()}</div>
      <div class="kpi-sub">${total} total, ${
  statsData.games.pending
} pending</div>
    </div>
    <div class="kpi-card">
      <div class="kpi-label">Hanging Piece Rate</div>
      <div class="kpi-value kpi-bad">${hRate}%</div>
      <div class="kpi-sub">pieces left en prise</div>
    </div>
    <div class="kpi-card">
      <div class="kpi-label">Blunders / Game</div>
      <div class="kpi-value kpi-bad">${bpg}</div>
      <div class="kpi-sub">target: below 3</div>
    </div>
    <div class="kpi-card">
      <div class="kpi-label">Current Win Rate</div>
      <div class="kpi-value kpi-good">${
  statsData.weekly_stats[0]
    ? statsData.weekly_stats[0].win_pct + '%'
    : '—'
}</div>
      <div class="kpi-sub">this week</div>
    </div>
    <div class="kpi-card">
      <div class="kpi-label">Total Mistakes</div>
      <div class="kpi-value kpi-warn">${statsData.mistake_breakdown
    .reduce((a, m) => a + m.count, 0)
    .toLocaleString()}</div>
      <div class="kpi-sub">across all analyzed games</div>
    </div>
  `;

    try {
      const sessions = await api('/api/sessions?limit=1');
      if (sessions.length && sessions[0].tilt_detected) {
        const tiltEl = document.createElement('div');
        tiltEl.className = 'tilt-warning';
        tiltEl.innerHTML = `
      <span class="tilt-warning-icon">⚠️</span>
      <div class="tilt-warning-body">
        <strong class="tilt-warning-title">Tilt Warning</strong>
        <div class="tilt-warning-copy">
          You've had 2+ consecutive losses today. Your accuracy typically drops 15% in this state.
          Consider taking a break and doing 5 drills instead.
        </div>
      </div>
    `;
        if (!document.getElementById('tilt-warning')) {
          tiltEl.id = 'tilt-warning';
          document
            .getElementById('view-dashboard')
            .insertBefore(tiltEl, document.getElementById('kpi-grid'));
        }
      }
    } catch (e) {}

    document.getElementById('hanging-pct-big').textContent = hRate + '%';
    document.getElementById('hanging-bar').value = Math.min(Number(hRate), 100);

    const tbody = document.getElementById('recent-games-body');
    tbody.innerHTML = statsData.recent_games
      .map(
        (g) => `
    <tr data-game-id="${g.id}">
      <td>${fmt(g.date)}</td>
      <td>${colorBadge(g.color)}</td>
      <td>${resultBadge(g.result)}</td>
      <td class="cell-strong">${esc(g.opponent_rating) || '?'}</td>
      <td><span class="opening-pill">${esc(g.opening_eco) || '?'}</span> ${truncate(
  g.opening_name,
  30
)}</td>
      <td><span class="${mistakeCountClass(g.mistake_count)}">${g.mistake_count}</span></td>
    </tr>
  `
      )
      .join('');

    renderWinRateChart(statsData);
    renderMistakeBreakdownChart(statsData);
  }

  function bindEvents() {
    document
      .getElementById('btn-review-latest')
      .addEventListener('click', reviewLatestGame);
    document.getElementById('recent-games-body').addEventListener('click', (e) => {
      const row = e.target.closest('tr[data-game-id]');
      if (row) onOpenGame(row.dataset.gameId);
    });
  }

  return {
    bindEvents,
    loadStats,
    reviewLatestGame,
  };
}
