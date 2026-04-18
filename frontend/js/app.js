import { api, apiPost } from './modules/api.js';
import {
  colorBadge,
  esc,
  fmt,
  mistakeCountClass,
  resultBadge,
  setBadgeCount,
  truncate,
} from './modules/ui.js';
import { createCoachView } from './modules/views/coach.js';
import { createDrillsView } from './modules/views/drills.js';
import { createGamesView } from './modules/views/games.js';
import { createMistakesView } from './modules/views/mistakes.js';
import { createOpeningsView } from './modules/views/openings.js';
import { createReviewView } from './modules/views/review.js';

if (typeof Chart === 'undefined') {
  document.body.innerHTML =
    '<div class="load-error">⚠️ Chart library failed to load. Check your network connection.</div>';
}
// ── STATE ──
let statsData = null;
let charts = {};

let reviewView;

const coachView = createCoachView({
  apiPost,
  buildReviewCoachPrompt,
  getStatsData: () => statsData,
  showView,
  toast,
});

reviewView = createReviewView({
  api,
  generateReport,
  onAskCoach: (prompt) => coachView.draftQuestion(prompt),
  showView,
});

const gamesView = createGamesView({
  api,
  loadGameDetail,
  toast,
});

const drillsView = createDrillsView({
  api,
  apiPost,
  toast,
});

const mistakesView = createMistakesView({
  api,
  charts,
  destroyChart,
  getStatsData: () => statsData,
  toast,
});

const openingsView = createOpeningsView({
  api,
  charts,
  destroyChart,
});

// __ BUTTONS __

document.getElementById('recent-games-body').addEventListener('click', e => {
  const row = e.target.closest('tr[data-game-id]');
  if (row) loadGameDetail(row.dataset.gameId);
});

document.getElementById('btn-sync').addEventListener('click', triggerSync);

document
  .getElementById('btn-analyze')
  .addEventListener('click', triggerAnalyze);

document.getElementById('btn-view-all-games').addEventListener('click', () => showView('games'));
document.getElementById('btn-start-drills').addEventListener('click', () => showView('drills'));
document.getElementById('btn-review-latest').addEventListener('click', reviewLatestGame);

document
  .querySelector('.back-btn')
  .addEventListener('click', () => showView('games'));

gamesView.bindEvents();
coachView.bindEvents();
drillsView.bindEvents();

// ── NAVIGATION ──
function showView(name) {
  document
    .querySelectorAll('.view')
    .forEach((v) => v.classList.remove('active'));
  document
    .querySelectorAll('.nav-item')
    .forEach((n) => n.classList.remove('active'));

  const viewEl = document.getElementById(`view-${name}`);
  if (viewEl) viewEl.classList.add('active');

  const navEl = document.querySelector(`[data-view="${name}"]`);
  if (navEl) navEl.classList.add('active');

  const titles = {
    dashboard: 'Dashboard',
    games: 'All Games',
    'game-detail': 'Game Analysis',
    mistakes: 'Mistake Analysis',
    openings: 'Opening Report',
    drills: 'Daily Drills',
    coach: 'Ask Coach',
  };
  document.getElementById('topbar-title').textContent = titles[name] || name;

  if (name === 'games') gamesView.ensureLoaded();
  if (name === 'mistakes') mistakesView.load();
  if (name === 'openings') openingsView.load();
  if (name === 'coach') coachView.init();
  if (name === 'drills') drillsView.ensureLoaded();
}

document.querySelectorAll('.nav-item[data-view]').forEach((btn) => {
  btn.addEventListener('click', () => showView(btn.dataset.view));
});

// ── TOAST ──
function toast(msg, duration = 3000) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), duration);
}

function updateDashboardFocus() {
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

function reviewLatestGame() {
  const latest = statsData?.recent_games?.[0];
  if (latest) {
    loadGameDetail(latest.id);
    return;
  }
  showView('games');
}

function buildReviewCoachPrompt() {
  return reviewView.buildCoachPrompt();
}

function loadGameDetail(gameId) {
  return reviewView.loadGameDetail(gameId);
}

// ── LOAD STATS ──
async function loadStats() {
  try {
    statsData = await api('/api/stats');
  } catch (e) {
    toast('Failed to load stats: ' + e.message);
    return;
  }

  const p = statsData.profile;
  // Show drill badge count
  const dueCount = statsData.drills_due;
  setBadgeCount(document.getElementById('drill-badge'), dueCount);

  // Sidebar rating
  document.getElementById('sidebar-rating').textContent =
    p.current_rating || '—';
  updateDashboardFocus();
  document.getElementById('btn-review-latest').disabled =
    !statsData.recent_games.length;
  coachView.updateContext();

  // KPI grid
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

  // Check today's sessions for tilt
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

  // Hanging bar
  document.getElementById('hanging-pct-big').textContent = hRate + '%';
  document.getElementById('hanging-bar').style.width =
    Math.min(hRate, 100) + '%';

  // Recent games table
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

  // Win rate chart
  renderWinRateChart();
  renderMistakeBreakdownChart();
}

// ── CHARTS ──
function destroyChart(id) {
  if (charts[id]) {
    charts[id].destroy();
    delete charts[id];
  }
}

function renderWinRateChart() {
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

function renderMistakeBreakdownChart() {
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

// ── SYNC / ANALYZE ──
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

// Generate Report - Coach

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
          loadGameDetail(gameId);
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
// ── INIT ──
loadStats();
