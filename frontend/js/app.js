if (typeof Chart === 'undefined') {
  document.body.innerHTML =
    '<div class="load-error">⚠️ Chart library failed to load. Check your network connection.</div>';
}

const API = ''; // same origin

function esc(s) {
  if (s == null) return '—';
  return String(s).replace(
    /[&<>"']/g,
    (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&#39;' }[
        c
      ])
  );
}
// ── STATE ──
let statsData = null;
let gamesPage = 0;
const PAGE_SIZE = 30;
let totalGames = 0;
let charts = {};
let gamesLoaded = false;
let drillsLoaded = false;
let mistakesRendered = false;

// __ BUTTONS __

document.getElementById('btn-reload-drills').addEventListener('click', loadDrills);

document.getElementById('recent-games-body').addEventListener('click', e => {
  const row = e.target.closest('tr[data-game-id]');
  if (row) loadGameDetail(row.dataset.gameId);
});

document.getElementById('all-games-body').addEventListener('click', e => {
  const row = e.target.closest('tr[data-game-id]');
  if (row) loadGameDetail(row.dataset.gameId);
});

document.getElementById('btn-sync').addEventListener('click', triggerSync);

document
  .getElementById('btn-analyze')
  .addEventListener('click', triggerAnalyze);

document
  .getElementById('btn-prev')
  .addEventListener('click', () => changePage(-1));

document
  .getElementById('btn-next')
  .addEventListener('click', () => changePage(1));

document.getElementById('btn-view-all-games').addEventListener('click', () => showView('games'));
document.getElementById('btn-start-drills').addEventListener('click', () => showView('drills'));
document.getElementById('btn-review-latest').addEventListener('click', reviewLatestGame);

document
  .querySelector('.back-btn')
  .addEventListener('click', () => showView('games'));

document.querySelector('.flip-btn').addEventListener('click', flipBoard);

document.querySelectorAll('.quality-btn').forEach((btn) => {
  btn.addEventListener('click', () => submitQuality(parseInt(btn.dataset.q)));
});

document.getElementById('btn-show-hint').addEventListener('click', showHint);

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
  };
  document.getElementById('topbar-title').textContent = titles[name] || name;

  if (name === 'games' && !gamesLoaded) {
    gamesLoaded = true;
    loadGames();
  }
  if (name === 'mistakes') loadMistakesView();
  if (name === 'openings') loadOpeningsView();
  if (name === 'drills') {
    if (!drillsLoaded) {
      drillsLoaded = true;
      loadDrills();
    } else if (drillIdx < drillQueue.length) renderBoard();
  }
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

// ── FETCH HELPERS ──
async function api(path) {
  const r = await fetch(API + path);
  if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
  return r.json();
}

async function apiPost(path, body = {}) {
  const r = await fetch(API + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
  return r.json();
}

// ── FORMAT HELPERS ──
function fmt(dateStr) {
  if (!dateStr) return '—';
  const d = new Date(dateStr);
  return isNaN(d.getTime()) ? '—' : d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: '2-digit' });
}

function resultBadge(r) {
  const safe = esc(r);
  const map = { win: 'badge-win', loss: 'badge-loss', draw: 'badge-draw' };
  return `<span class="badge ${map[r] || ''}">${safe.toUpperCase()}</span>`;
}

function colorBadge(c) {
  const safe = esc(c);
  return `<span class="badge badge-${safe}">${
    safe.charAt(0).toUpperCase() + safe.slice(1)
  }</span>`;
}

function mistakeTag(type) {
  if (!type) return '<span class="mtag">—</span>';
  const labels = {
    blunder: '⚡ Blunder',
    hanging_piece: '⚠️ Hanging',
    mistake: '△ Mistake',
  };
  return `<span class="mtag mtag-${esc(type)}">${
    labels[type] || esc(type)
  }</span>`;
}

function truncate(str, n) {
  if (!str) return '—';
  const s = String(str);
  return esc(s.length > n ? s.slice(0, n) + '…' : s);
}

function setBadgeCount(el, count) {
  if (!el) return;
  if (count > 0) {
    el.textContent = count;
    el.hidden = false;
    return;
  }
  el.textContent = '';
  el.hidden = true;
}

function mistakeCountClass(count) {
  if (count > 10) return 'mistake-count mistake-count-high';
  if (count > 5) return 'mistake-count mistake-count-medium';
  return 'mistake-count mistake-count-low';
}

function analysisStatusMarkup(status) {
  if (status === 1) {
    return '<span class="status-text status-done">✓ analyzed</span>';
  }
  if (status === 2) {
    return '<span class="status-text status-error">✗ error</span>';
  }
  return '<span class="status-text status-pending">⏳ pending</span>';
}

function evalDeltaClass(delta) {
  if (delta == null) return 'cell-strong cell-muted';
  if (delta < -200) return 'cell-strong text-error';
  if (delta < -100) return 'cell-strong text-warning';
  return 'cell-strong cell-muted';
}

function openingToneClass(winPct) {
  if (winPct >= 50) return 'progress-fill-good';
  if (winPct >= 35) return 'progress-fill-warn';
  return 'progress-fill-bad';
}

function openingToneTextClass(winPct) {
  if (winPct >= 50) return 'text-success';
  if (winPct >= 35) return 'text-warning';
  return 'text-error';
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

// ── GAMES LIST ──
async function loadGames() {
  const offset = gamesPage * PAGE_SIZE;
  let data;
  try {
    data = await api(`/api/games?limit=${PAGE_SIZE}&offset=${offset}`);
  } catch (e) {
    toast('Failed to load games');
    return;
  }

  document.getElementById('btn-prev').disabled = gamesPage === 0;
  document.getElementById('btn-next').disabled = data.length < PAGE_SIZE;
  document.getElementById('page-label').textContent = `Page ${gamesPage + 1}`;
  document.getElementById('games-count-label').textContent =
    data.length > 0
      ? `Showing ${gamesPage * PAGE_SIZE + 1}–${gamesPage * PAGE_SIZE + data.length}`
      : 'No games loaded';

  const tbody = document.getElementById('all-games-body');
  if (data.length === 0) {
    tbody.innerHTML =
      '<tr><td colspan="7"><div class="empty"><div class="empty-icon">♟</div>No games found</div></td></tr>';
    return;
  }

  tbody.innerHTML = data
    .map(
      (g) => `
    <tr data-game-id="${g.id}">
      <td>${fmt(g.date)}</td>
      <td>${colorBadge(g.color)}</td>
      <td>${resultBadge(g.result)}</td>
      <td class="cell-strong">${esc(g.opponent_rating) || '?'}</td>
      <td>
        <span class="opening-pill">${esc(g.opening_eco) || '?'}</span>
        ${truncate(g.opening_name, 28)}
      </td>
      <td>
        <span class="${mistakeCountClass(g.mistake_count)}">
          ${g.mistake_count}
        </span>
      </td>
      <td>${analysisStatusMarkup(g.analyzed)}</td>
    </tr>
  `
    )
    .join('');
}

function changePage(dir) {
  if (dir === -1 && gamesPage === 0) return;
  gamesPage += dir;
  loadGames();
}

// ── GAME DETAIL ──
async function loadGameDetail(gameId) {
  showView('game-detail');
  const container = document.getElementById('game-detail-content');
  container.innerHTML = '<div class="skeleton skeleton-tall"></div>';

  let data;
  try {
    data = await api(`/api/games/${gameId}`);
  } catch (e) {
    container.innerHTML = `<div class="empty">Failed to load game: ${esc(e.message)}</div>`;
    return;
  }

  const g = data.game;
  const mistakes = data.mistakes || [];
  const moves = data.moves || [];
  const playerMoves = moves.filter((m) => m.color === g.color);

  container.innerHTML = `
    <div class="game-meta-row">
      ${colorBadge(g.color)}
      ${resultBadge(g.result)}
      <span class="opening-pill">${g.opening_eco || '?'}</span>
      <span class="game-meta-detail">${
  esc(g.opening_name) || 'Unknown opening'
}</span>
      <span class="meta-label">${fmt(g.date)}</span>
      <span class="meta-label">vs. ${
  esc(g.opponent_rating) || '?'
} rated</span>
    </div>

    <div class="game-detail-grid">
      <div>
        <div class="card">
          <div class="card-header">
            <div class="card-title">Your Moves Analysis</div>
            <div class="table-meta">${
  playerMoves.length
} moves · ${mistakes.length} mistakes</div>
          </div>
          <table>
            <thead>
              <tr>
                <th>#</th>
                <th>Move</th>
                <th>Best Was</th>
                <th>Eval Δ</th>
                <th>Quality</th>
                <th>Phase</th>
              </tr>
            </thead>
            <tbody>
              ${playerMoves
    .map((m) => {
      const hanging = m.is_hanging_piece === 1;
      const isCritical = mistakes.find(
        (mk) => mk.is_critical && mk.played_move === m.uci
      );
      const rowClass = isCritical
        ? 'critical-row'
        : hanging
          ? 'hanging-row'
          : '';
      const qClass = `move-${m.classification || 'good'}`;
      const delta =
                    m.eval_delta != null
                      ? (m.eval_delta > 0 ? '+' : '') + m.eval_delta
                      : '—';
      return `
                  <tr class="${rowClass}">
                    <td class="cell-muted">${m.move_number}.</td>
                    <td class="${qClass} cell-code-strong">${esc(
  m.san)
}</td>
                    <td class="cell-code cell-muted">
                      ${
  m.best_move_san && m.best_move_san !== m.san
    ? `<span class="text-success">${esc(m.best_move_san)}</span>`
    : '—'
}
                    </td>
                    <td class="${evalDeltaClass(m.eval_delta)}">${delta}</td>
                    <td><span class="mtag mtag-${esc(m.classification) || 'good'}">${
  m.classification || '—'
}</span></td>
                    <td class="cell-phase">${esc(
  m.phase) || '—'
}</td>
                  </tr>
                `;
    })
    .join('')}
            </tbody>
          </table>
        </div>
      </div>

      <div class="mistake-panel">
        <div class="mistake-panel-title">
          Critical Mistakes (${mistakes.length})
        </div>
        ${
  mistakes.length === 0
    ? '<div class="empty empty-compact"><div class="empty-icon">✓</div>No significant mistakes found</div>'
    : mistakes
      .slice(0, 8)
      .map(
        (mk, i) => `
            <div class="mistake-item${mk.is_critical ? ' active' : ''}">
              <div class="mistake-item-header">
                ${mistakeTag(mk.type)}
                <div class="eval-loss">-${mk.eval_loss}cp</div>
              </div>
              <div class="detail-row">
                <span class="detail-label">Phase:</span>
                <span>${esc(mk.phase) || '—'}</span>
              </div>
              <div class="detail-row">
                <span class="detail-label">Played:</span>
                <span class="cell-code text-error">${esc(
    mk.played_move
  )}</span>
                <span class="detail-label">→ Better:</span>
                <span class="cell-code text-success">${esc(
    mk.best_move
  )}</span>
              </div>
              ${
  mk.is_critical
    ? '<div class="critical-note">⚡ Critical moment — game turned here</div>'
    : ''
}
            </div>
          `
      )
      .join('')
}
      </div>
    </div>
    ${
  data.journal
    ? `
  <div class="card card-top-gap">
    <div class="card-header">
      <div class="card-title">🧠 Coach Note</div>
      <div class="journal-meta">Generated by chess-coach AI</div>
    </div>
    <div class="journal-content">${esc(
    data.journal.coach_note
  )}</div>
  </div>
`
    : `
  <div class="card card-top-gap card-body">
    <div class="journal-empty-row">
      <div>
        <div class="journal-empty-title">No coach note yet</div>
        <div class="journal-empty-subtitle">Generate a coaching analysis for this game</div>
      </div>
      <button class="btn btn-primary btn-generate-report">
        Generate Report
      </button>
    </div>
  </div>
`
}
  `;
const reportBtn = container.querySelector('.btn-generate-report');
if (reportBtn) {
  reportBtn.addEventListener('click', () => generateReport(gameId));
}
}


// ── MISTAKES VIEW ──
async function loadMistakesView() {
  if (!statsData) { toast('Stats still loading…'); return; }
  if (mistakesRendered) return;
  mistakesRendered = true;

  const breakdown = statsData.mistake_breakdown;
  const byType = {};
  breakdown.forEach((m) => {
    byType[m.type] = m.count;
  });

  document.getElementById('m-blunders').textContent = (
    byType.blunder || 0
  ).toLocaleString();
  document.getElementById('m-hanging').textContent = (
    byType.hanging_piece || 0
  ).toLocaleString();
  document.getElementById('m-mistakes').textContent = (
    byType.mistake || 0
  ).toLocaleString();

  // Phase chart — fetch from recent games

  try {
    const phaseData = await api('/api/mistakes/by-phase');
    destroyChart('phase');
    const ctxPhase = document.getElementById('chart-phase').getContext('2d');
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

  // Blunder trend from recent games
  const recent = statsData.recent_games.slice().reverse();
  destroyChart('blunder-trend');
  const ctxTrend = document
    .getElementById('chart-blunder-trend')
    .getContext('2d');
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

  // Critical mistakes table
  const games = await api('/api/games?limit=50&offset=0');
  const analyzedGames = games.slice(0, 20).filter(g => g.analyzed === 1);
  const results = await Promise.allSettled(
    analyzedGames.map(g => api(`/api/games/${g.id}/critical`))
  );
  const rows = results
    .map((r, i) => r.status === 'fulfilled'
      ? { ...r.value, game_date: analyzedGames[i].date }
      : null)
    .filter(Boolean);

  const tbody = document.getElementById('critical-mistakes-body');
  tbody.innerHTML =
    rows
      .map(
        (m) => `
    <tr>
      <td>${fmt(m.game_date)}</td>
      <td>${mistakeTag(m.type)}</td>
      <td class="cell-phase">${m.phase || '—'}</td>
      <td class="cell-code text-error">${esc(
    m.played_move
  )}</td>
      <td class="cell-code text-success">${esc(
  m.best_move)
}</td>
      <td class="cell-strong text-error">−${m.eval_loss}</td>
    </tr>
  `
      )
      .join('') ||
    '<tr><td colspan="6"><div class="empty">No data</div></td></tr>';
}

// ── OPENINGS VIEW ──
let openingsLoaded = false;
async function loadOpeningsView() {
  if (openingsLoaded) return;
  openingsLoaded = true;
  let games;
  try {
    games = await api('/api/games?limit=100&offset=0');
  } catch (e) {
    return;
  }

  const openingMap = {};
  for (const g of games) {
    if (!g.opening_eco || !g.analyzed) continue;
    const key = `${g.opening_eco}|${g.color}`;
    if (!openingMap[key]) {
      openingMap[key] = {
        eco: g.opening_eco,
        name: g.opening_name,
        color: g.color,
        games: 0,
        wins: 0,
      };
    }
    openingMap[key].games++;
    if (g.result === 'win') openingMap[key].wins++;
  }

  const allOpenings = Object.values(openingMap).sort(
    (a, b) => b.games - a.games
  );

  const whiteTop = allOpenings.filter((o) => o.color === 'white').slice(0, 6);
  const blackTop = allOpenings.filter((o) => o.color === 'black').slice(0, 6);

  function renderOpeningChart(canvasId, data) {
    destroyChart(canvasId);
    const ctx = document.getElementById(canvasId).getContext('2d');
    charts[canvasId] = new Chart(ctx, {
      type: 'bar',
      data: {
        labels: data.map((o) => o.eco),
        datasets: [
          {
            label: 'Games',
            data: data.map((o) => o.games),
            backgroundColor: 'rgba(88,166,255,0.5)',
            borderRadius: 3,
          },
          {
            label: 'Wins',
            data: data.map((o) => o.wins),
            backgroundColor: 'rgba(63,185,80,0.7)',
            borderRadius: 3,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { labels: { color: '#7d8590', font: { size: 11 } } },
        },
        scales: {
          x: {
            grid: { color: 'rgba(255,255,255,0.04)' },
            ticks: { color: '#7d8590' },
          },
          y: {
            grid: { color: 'rgba(255,255,255,0.04)' },
            ticks: { color: '#7d8590' },
          },
        },
      },
    });
  }

  renderOpeningChart('chart-openings-white', whiteTop);
  renderOpeningChart('chart-openings-black', blackTop);

  const tbody = document.getElementById('openings-body');
  tbody.innerHTML = allOpenings
    .slice(0, 30)
    .map((o) => {
      const winPct = o.games > 0 ? ((o.wins / o.games) * 100).toFixed(0) : 0;
      return `
      <tr>
        <td class="cell-code-strong">${esc(o.eco)}</td>
        <td>${truncate(o.name, 40)}</td>
        <td>${colorBadge(o.color)}</td>
        <td>${o.games}</td>
        <td>${o.wins}</td>
        <td>
          <div class="bar-row">
            <span class="bar-label ${openingToneTextClass(Number(winPct))}">${winPct}%</span>
            <div class="progress-bar progress-bar-flex">
              <div
                class="progress-fill ${openingToneClass(Number(winPct))}"
                data-opening-width="${winPct}"
              ></div>
            </div>
          </div>
        </td>
      </tr>
    `;
    })
    .join('');

  tbody
    .querySelectorAll('[data-opening-width]')
    .forEach((el) => {
      el.style.width = `${el.dataset.openingWidth}%`;
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
// ══════════════════════════════════════════════
// DRILL ENGINE
// ══════════════════════════════════════════════

const PIECES = {
  wP: '♙',
  wN: '♘',
  wB: '♗',
  wR: '♖',
  wQ: '♕',
  wK: '♔',
  bP: '♟',
  bN: '♞',
  bB: '♝',
  bR: '♜',
  bQ: '♛',
  bK: '♚',
};

let drillQueue = [];
let drillIdx = 0;
let drillFlipped = false;
let selectedSq = null;
let boardPosition = {};
let currentTurn = 'w';
let correctUCI = null;
let answered = false;
let hintShown = false;
let sessionDone = 0;
let sessionCorrect = 0;
let sessionWrong = 0;
let lastFrom = null;
let lastTo = null;

// FEN parser → {square: 'wP'|'bK'|...}
function parseFen(fen) {
  const pos = {};
  const rows = fen.split(' ')[0].split('/');
  const files = 'abcdefgh';
  rows.forEach((row, ri) => {
    let fi = 0;
    for (const ch of row) {
      if (/\d/.test(ch)) {
        fi += parseInt(ch);
        continue;
      }
      const rank = 8 - ri;
      const sq = files[fi] + rank;
      const color = ch === ch.toUpperCase() ? 'w' : 'b';
      const type = ch.toUpperCase();
      pos[sq] = color + type;
      fi++;
    }
  });
  return pos;
}

function fenTurn(fen) {
  return fen.split(' ')[1] || 'w';
}

// UCI → {from, to, promo}
function parseUCI(uci) {
  return { from: uci.slice(0, 2), to: uci.slice(2, 4), promo: uci[4] || null };
}

// Apply a UCI move to a position dict (simple, no legality check)
function applyMove(pos, uci, turn) {
  const p = { ...pos };
  const { from, to, promo } = parseUCI(uci);
  const piece = p[from];
  if (!piece) return p;
  delete p[from];

  // En passant
  if (piece[1] === 'P' && from[0] !== to[0] && !p[to]) {
    const epRank = turn === 'w' ? parseInt(to[1]) - 1 : parseInt(to[1]) + 1;
    delete p[to[0] + epRank];
  }

  // Castling
  if (piece[1] === 'K') {
    if (from === 'e1' && to === 'g1') {
      delete p['h1'];
      p['f1'] = 'wR';
    }
    if (from === 'e1' && to === 'c1') {
      delete p['a1'];
      p['d1'] = 'wR';
    }
    if (from === 'e8' && to === 'g8') {
      delete p['h8'];
      p['f8'] = 'bR';
    }
    if (from === 'e8' && to === 'c8') {
      delete p['a8'];
      p['d8'] = 'bR';
    }
  }

  // Promotion
  if (promo) {
    p[to] = turn + promo.toUpperCase();
  } else {
    p[to] = piece;
  }
  return p;
}

function renderBoard() {
  const board = document.getElementById('drill-board');
  if (!board) return;
  board.innerHTML = '';
  const grid = document.createElement('div');
  grid.className = 'board-grid';

  const files = 'abcdefgh';
  for (let r = 8; r >= 1; r--) {
    for (let fi = 0; fi < 8; fi++) {
      const f = drillFlipped ? files[7 - fi] : files[fi];
      const rank = drillFlipped ? 9 - r : r;
      const sq = f + rank;
      const isLight = (fi + r) % 2 === 0;

      const cell = document.createElement('div');
      cell.className = 'sq ' + (isLight ? 'light' : 'dark');
      cell.dataset.sq = sq;

      if (selectedSq === sq) cell.classList.add('selected');
      if (lastFrom === sq) cell.classList.add('last-from');
      if (lastTo === sq) cell.classList.add('last-to');

      // File label on rank 1
      if (drillFlipped ? rank === 8 : rank === 1) {
        const lbl = document.createElement('div');
        lbl.className = 'sq-label-file';
        lbl.textContent = f;
        lbl.style.color = isLight ? '#b58863' : '#f0d9b5';
        cell.appendChild(lbl);
      }

      // Rank label on file a
      if (drillFlipped ? f === 'h' : f === 'a') {
        const lbl = document.createElement('div');
        lbl.className = 'sq-label-rank';
        lbl.textContent = rank;
        lbl.style.color = isLight ? '#b58863' : '#f0d9b5';
        cell.appendChild(lbl);
      }

      const piece = boardPosition[sq];
      if (piece && PIECES[piece]) {
        const pieceEl = document.createElement('div');
        pieceEl.className = 'piece';
        pieceEl.textContent = PIECES[piece];
        pieceEl.style.color = piece[0] === 'w' ? '#fff' : '#1a1a1a';
        pieceEl.style.textShadow =
          piece[0] === 'w'
            ? '0 1px 3px rgba(0,0,0,0.8)'
            : '0 1px 2px rgba(255,255,255,0.2)';
        cell.appendChild(pieceEl);
      }

      cell.addEventListener('click', () => handleSquareClick(sq));
      grid.appendChild(cell);
    }
  }
  board.appendChild(grid);
}

function handleSquareClick(sq) {
  if (answered) return;

  const piece = boardPosition[sq];

  if (!selectedSq) {
    // Must click own piece
    if (!piece || piece[0] !== currentTurn) return;
    selectedSq = sq;
    renderBoard();
    return;
  }

  if (selectedSq === sq) {
    selectedSq = null;
    renderBoard();
    return;
  }

  // Clicked another own piece — reselect
  if (piece && piece[0] === currentTurn) {
    selectedSq = sq;
    renderBoard();
    return;
  }

  // Attempt move
  const attemptedUCI = selectedSq + sq;
  const from = selectedSq;
  selectedSq = null;
  checkAnswer(from, sq, attemptedUCI);
}

function checkAnswer(from, to, uci) {
  answered = true;
  const correct = parseUCI(correctUCI);
  const isCorrect = from === correct.from && to === correct.to;

  lastFrom = from;
  lastTo = to;

  const fb = document.getElementById('drill-feedback');

  if (isCorrect) {
    // Show the move on board
    boardPosition = applyMove(boardPosition, correctUCI, currentTurn);
    lastFrom = correct.from;
    lastTo = correct.to;
    renderBoard();
    fb.className = 'drill-feedback correct';
    fb.textContent =
      '✓ Correct! ' + correctUCI.toUpperCase() + ' was the best move.';
    sessionCorrect++;
  } else {
    renderBoard();
    fb.className = 'drill-feedback wrong';
    fb.textContent = `✗ Not the best. You played ${uci.toUpperCase()}, but ${correctUCI.toUpperCase()} was correct.`;
    sessionWrong++;
    // Show correct move after short delay
    setTimeout(() => {
      boardPosition = applyMove(boardPosition, correctUCI, currentTurn);
      lastFrom = correct.from;
      lastTo = correct.to;
      renderBoard();
    }, 800);
  }

  sessionDone++;
  updateSessionStats();
  document.getElementById('quality-section').hidden = false;
  document.getElementById('drill-hint-card').hidden = true;
  updateQueueList();
}

function showHint() {
  if (answered) return;
  hintShown = true;
  const { from } = parseUCI(correctUCI);
  // Highlight the from square
  const cell = document.querySelector(`[data-sq="${from}"]`);
  if (cell) cell.classList.add('hint');
  const fb = document.getElementById('drill-feedback');
  fb.className = 'drill-feedback info';
  fb.textContent = `Hint: move the piece on ${from.toUpperCase()}`;
}

async function submitQuality(q) {
  const item = drillQueue[drillIdx];
  if (!item) return;

  try {
    await apiPost('/api/drills/result', { item_id: item.id, quality: q });
  } catch (e) {
    console.error('Failed to submit drill result:', e);
  }

  // Advance to next
  drillIdx++;
  loadDrillItem();
}

function loadDrillItem() {
  const total = drillQueue.length;
  document.getElementById('ds-due').textContent = total;
  document.getElementById('drill-counter').textContent = `${Math.min(
    drillIdx + 1,
    total
  )} / ${total}`;

  if (drillIdx >= total) {
    // All done
    document.getElementById('drill-board').innerHTML = '';
    document.getElementById('drill-feedback').className = 'drill-feedback';
    document.getElementById('quality-section').hidden = true;
    document.getElementById('drill-hint-card').hidden = true;
    document.getElementById('drill-empty').hidden = false;
    document.getElementById('drill-turn-label').textContent =
      'Session complete!';
    updateSessionStats();
    return;
  }

  document.getElementById('drill-empty').hidden = true;

  const item = drillQueue[drillIdx];
  answered = false;
  hintShown = false;
  selectedSq = null;
  lastFrom = null;
  lastTo = null;
  correctUCI = item.correct_move;

  boardPosition = parseFen(item.fen);
  currentTurn = fenTurn(item.fen);

  const turnLabel = currentTurn === 'w' ? 'White to move' : 'Black to move';
  document.getElementById(
    'drill-turn-label'
  ).textContent = `${turnLabel} — Find the best move`;

  const fb = document.getElementById('drill-feedback');
  fb.className = 'drill-feedback';
  document.getElementById('quality-section').hidden = true;

  // Show hint card
  const hintCard = document.getElementById('drill-hint-card');
  hintCard.hidden = false;
  document.getElementById('drill-theme-label').textContent = item.theme
    ? `Theme: ${item.theme.replace('_', ' ')}`
    : 'Type: ' + (item.mistake_type || 'mistake');

  renderBoard();
  updateQueueList();
  updateSessionStats();
}

function updateQueueList() {
  const list = document.getElementById('drill-queue-list');
  const show = drillQueue.slice(drillIdx, drillIdx + 8);
  if (show.length === 0) {
    list.innerHTML = '';
    return;
  }
  list.innerHTML = show
    .map(
      (item, i) => `
    <div class="drill-queue-item ${i === 0 ? 'current' : ''}">
      <span class="queue-order">${drillIdx + i + 1}.</span>
      <span class="mtag queue-tag mtag-${
  item.mistake_type || 'blunder'
}">
        ${(item.mistake_type || 'blunder').replace('_', ' ')}
      </span>
      <span class="queue-date">
        ${esc(item.due_date) || ''}
      </span>
    </div>
  `
    )
    .join('');
}

function updateSessionStats() {
  document.getElementById('ds-done').textContent = sessionDone;
  document.getElementById('ds-correct').textContent = sessionCorrect;
  document.getElementById('ds-wrong').textContent = sessionWrong;

  const total = drillQueue.length;
  const pct = total > 0 ? (sessionDone / total) * 100 : 0;
  document.getElementById('session-progress-bar').style.width = pct + '%';
  document.getElementById('drill-progress-text').textContent =
    sessionDone > 0
      ? `${sessionDone} done · ${sessionCorrect} correct · accuracy: ${Math.round(
        (sessionCorrect / sessionDone) * 100
      )}%`
      : '';
}

async function loadDrills() {
  drillIdx = 0;
  sessionDone = 0;
  sessionCorrect = 0;
  sessionWrong = 0;
  selectedSq = null;

  try {
    drillQueue = await api('/api/drills/due?limit=15');
  } catch (e) {
    toast('Failed to load drills: ' + e.message);
    return;
  }

  // Update sidebar badge
  setBadgeCount(document.getElementById('drill-badge'), drillQueue.length);

  loadDrillItem();
}

function flipBoard() {
  drillFlipped = !drillFlipped;
  renderBoard();
}

// ── INIT ──
loadStats();
