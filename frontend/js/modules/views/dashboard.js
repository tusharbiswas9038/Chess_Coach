import {
  colorBadge,
  esc,
  fmt,
  mistakeCountClass,
  resultBadge,
  setBadgeCount,
  tableStateRowMarkup,
  truncate,
} from '../ui.js';
import { createDomCache } from '../dom.js';
import { endpoints, normalize } from '../contracts.js';
import { createCache } from '../cache.js';
import { baseCartesianOptions, chartPalette, doughnutOptions } from '../charts.js';

export function createDashboardView({
  api,
  apiContract,
  charts,
  destroyChart,
  getStatsData,
  onOpenGame,
  onOpenGames,
  onStatsLoaded,
  setStatsData,
  toast,
}) {
  const dom = createDomCache();
  const cache = createCache('api');
  const fetchContract =
    typeof apiContract === 'function'
      ? apiContract
      : async (path, normalizer, label = 'response') => {
          const payload = await api(path);
          try {
            return normalizer(payload);
          } catch (e) {
            throw new Error(`${label}: ${e.message}`);
          }
        };
  let btnSyncGames; // Define btnSyncGames here
  let weeklyPlanStorageKey = null;

  function getWeekKey() {
    const now = new Date();
    const firstJan = new Date(now.getFullYear(), 0, 1);
    const dayOffset = (now - firstJan) / 86400000;
    const week = Math.ceil((dayOffset + firstJan.getDay() + 1) / 7);
    return `${now.getFullYear()}-W${String(week).padStart(2, '0')}`;
  }

  function saveWeeklyPlanState(actions, checkedIndexes) {
    if (!weeklyPlanStorageKey) return;
    const payload = {
      actions,
      checkedIndexes: [...checkedIndexes],
      savedAt: Date.now(),
    };
    localStorage.setItem(weeklyPlanStorageKey, JSON.stringify(payload));
  }

  function loadWeeklyPlanState(actions) {
    if (!weeklyPlanStorageKey) return new Set();
    const raw = localStorage.getItem(weeklyPlanStorageKey);
    if (!raw) return new Set();
    try {
      const data = JSON.parse(raw);
      if (!Array.isArray(data.actions) || data.actions.join('||') !== actions.join('||')) {
        return new Set();
      }
      return new Set(Array.isArray(data.checkedIndexes) ? data.checkedIndexes : []);
    } catch {
      return new Set();
    }
  }

  function renderWeeklyActions(actions) {
    const actionsList = dom.byId('focus-actions-list');
    const checked = loadWeeklyPlanState(actions);
    actionsList.innerHTML = actions
      .slice(0, 4)
      .map((action, idx) => {
        const isChecked = checked.has(idx);
        return `
          <li class="focus-action-item${isChecked ? ' is-done' : ''}" data-action-index="${idx}">
            <label class="focus-action-label">
              <input type="checkbox" ${isChecked ? 'checked' : ''} />
              <span>${esc(action)}</span>
            </label>
          </li>
        `;
      })
      .join('');

    actionsList.querySelectorAll('[data-action-index]').forEach((item) => {
      const checkbox = item.querySelector('input[type="checkbox"]');
      if (!checkbox) return;
      checkbox.addEventListener('change', () => {
        const idx = Number(item.dataset.actionIndex);
        if (checkbox.checked) {
          checked.add(idx);
          item.classList.add('is-done');
        } else {
          checked.delete(idx);
          item.classList.remove('is-done');
        }
        saveWeeklyPlanState(actions, checked);
      });
    });
  }

  function updateDashboardFocus(statsData, weeklyFocus = null) {
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

    if (weeklyFocus?.primary_focus) {
      const focusType = weeklyFocus.primary_focus.type.replace('_', ' ');
      const phase = weeklyFocus.primary_focus.phase || 'all phases';
      title = `Weekly focus: ${focusType} (${phase})`;
      if (Array.isArray(weeklyFocus.actions) && weeklyFocus.actions.length) {
        text = weeklyFocus.actions[0];
      }
    }

    dom.byId('focus-primary-value').textContent = title;
    dom.byId('focus-primary-text').textContent = text;
    dom.byId('focus-drills-due').textContent = dueCount;
    dom.byId('focus-games-pending').textContent = pending;
    if (weeklyFocus?.mistake_trend) {
      dom.byId('focus-weekly-form').textContent = weeklyFocus.mistake_trend;
    } else {
      dom.byId('focus-weekly-form').textContent =
        weeklyWinRate != null ? `${weeklyWinRate}%` : '—';
    }

    const actions = Array.isArray(weeklyFocus?.actions) && weeklyFocus.actions.length
      ? weeklyFocus.actions
      : ['Review your latest critical mistake and complete one drill block today.'];
    const focusKey = weeklyFocus?.primary_focus
      ? `${weeklyFocus.primary_focus.type}:${weeklyFocus.primary_focus.phase || 'all'}`
      : 'fallback';
    weeklyPlanStorageKey = `weekly-plan:${getWeekKey()}:${focusKey}`;
    renderWeeklyActions(actions);
  }

  function updateSyncButtonWarning(dueDrillsWarning) {
    if (btnSyncGames) {
      if (dueDrillsWarning) {
        btnSyncGames.classList.add('btn-warning');
        btnSyncGames.title = 'Review your drills first!';
      } else {
        btnSyncGames.classList.remove('btn-warning');
        btnSyncGames.title = 'Sync new games from Chess.com';
      }
    }
  }

  function renderWinRateChart(statsData) {
    destroyChart('winrate');
    const weeks = (statsData.weekly_stats || []).slice().reverse();
    const ctx = dom.byId('chart-winrate').getContext('2d');
    charts.winrate = new Chart(ctx, {
      type: 'line',
      data: {
        labels: weeks.map((w) => (w.week_start ? w.week_start.slice(5) : '')),
        datasets: [
          {
            label: 'Win %',
            data: weeks.map((w) => w.win_pct),
            borderColor: chartPalette.primary,
            backgroundColor: chartPalette.primarySoft,
            fill: true,
            tension: 0.36,
            borderWidth: 2,
            pointRadius: 0,
            pointHoverRadius: 4,
            pointBackgroundColor: chartPalette.primary,
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
  }

  function renderMistakeBreakdownChart(statsData) {
    destroyChart('mistakes');
    const data = statsData.mistake_breakdown || [];
    const ctx = dom.byId('chart-mistakes').getContext('2d');
    charts.mistakes = new Chart(ctx, {
      type: 'doughnut',
      data: {
        labels: data.map((m) => m.type.replace('_', ' ')),
        datasets: [
          {
            data: data.map((m) => m.count),
            backgroundColor: [
              chartPalette.errorSoft,
              chartPalette.warningSoft,
              chartPalette.blueSoft,
            ],
            borderColor: [chartPalette.error, chartPalette.warning, chartPalette.blue],
            borderWidth: 1,
          },
        ],
      },
      options: doughnutOptions({ legendPosition: 'right' }),
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
    dom.byId('kpi-grid').innerHTML = Array.from({ length: 5 })
      .map(
        () => `
      <div class="kpi-card">
        <div class="skeleton skeleton-line skeleton-line-sm"></div>
        <div class="skeleton skeleton-line skeleton-line-lg"></div>
        <div class="skeleton skeleton-line skeleton-line-md"></div>
      </div>
    `
      )
      .join('');
    dom.byId('recent-games-body').innerHTML = tableStateRowMarkup('Loading recent games…', 7, {
      kind: 'loading',
    });

    let statsData;
    let weeklyFocus = null;
    let latestSession = null;

    try {
      const bootstrap = await cache.getOrSet(
        'dashboard:bootstrap',
        () =>
          fetchContract(
            endpoints.dashboardBootstrap(),
            normalize.dashboardBootstrap,
            'dashboardBootstrap'
          ),
        20000
      );
      statsData = bootstrap.stats;
      weeklyFocus = bootstrap.weekly_focus;
      latestSession = bootstrap.latest_session;
    } catch (bootstrapError) {
      const [statsResult, weeklyFocusResult, sessionsResult] = await Promise.allSettled([
        fetchContract(endpoints.stats(), normalize.stats, 'stats'),
        fetchContract(endpoints.weeklyFocus(), normalize.weeklyFocus, 'weeklyFocus'),
        fetchContract(endpoints.sessions(1), normalize.sessions, 'sessions'),
      ]);

      if (statsResult.status !== 'fulfilled') {
        toast('Failed to load stats: ' + statsResult.reason.message);
        return;
      }

      statsData = statsResult.value;
      weeklyFocus =
        weeklyFocusResult.status === 'fulfilled' ? weeklyFocusResult.value : null;
      latestSession =
        sessionsResult.status === 'fulfilled' && sessionsResult.value.length
          ? sessionsResult.value[0]
          : null;
    }
    setStatsData(statsData);

    const p = statsData.profile;
    const dueCount = statsData.drills_due;
    setBadgeCount(dom.byId('drill-badge'), dueCount);
    updateSyncButtonWarning(statsData.due_drills_warning); // Update the sync button

    dom.byId('sidebar-rating').textContent =
      p.current_rating || '—';
    updateDashboardFocus(statsData, weeklyFocus);
    dom.byId('btn-review-latest').disabled =
      !statsData.recent_games.length;

    onStatsLoaded();

    const hRate = (statsData.hanging_piece_rate * 100).toFixed(1);
    const bpg = statsData.blunders_per_game;
    const analyzed = statsData.games.analyzed;
    const total = statsData.games.total;

    dom.byId('kpi-grid').innerHTML = `
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

    renderTiltWarning(Boolean(latestSession && latestSession.tilt_detected));

    dom.byId('hanging-pct-big').textContent = hRate + '%';
    dom.byId('hanging-bar').value = Math.min(Number(hRate), 100);

    const tbody = dom.byId('recent-games-body');
    if (!statsData.recent_games.length) {
      tbody.innerHTML = tableStateRowMarkup('No recent games available', 7);
      renderWinRateChart(statsData);
      renderMistakeBreakdownChart(statsData);
      return;
    }
    tbody.innerHTML = statsData.recent_games
      .map(
        (g) => `
    <tr>
      <td data-label="Date">${fmt(g.date)}</td>
      <td data-label="Color">${colorBadge(g.color)}</td>
      <td data-label="Result">${resultBadge(g.result)}</td>
      <td data-label="Opponent" class="cell-strong">${esc(g.opponent_rating) || '?'}</td>
      <td data-label="Opening"><span class="opening-pill">${esc(g.opening_eco) || '?'}</span> ${truncate(
  g.opening_name,
  30
)}</td>
      <td data-label="Mistakes"><span class="${mistakeCountClass(g.mistake_count)}">${g.mistake_count}</span></td>
      <td data-label="Action"><button class="btn btn-ghost btn-table-action" type="button" data-open-game-id="${g.id}">Review</button></td>
    </tr>
  `
      )
      .join('');

    renderWinRateChart(statsData);
    renderMistakeBreakdownChart(statsData);
  }

  function renderTiltWarning(tiltDetected) {
    const existingTiltEl = dom.byId('tilt-warning');
    if (tiltDetected && !existingTiltEl) {
      const tiltEl = document.createElement('div');
      tiltEl.className = 'tilt-warning';
      tiltEl.innerHTML = `
        <span class="tilt-warning-icon" aria-hidden="true">!</span>
        <div class="tilt-warning-body">
          <strong class="tilt-warning-title">Tilt Warning</strong>
          <div class="tilt-warning-copy">
            You've had 2+ consecutive losses today. Your accuracy typically drops 15% in this state.
            Consider taking a break and doing 5 drills instead.
          </div>
        </div>
      `;
      tiltEl.id = 'tilt-warning';
      dom.byId('view-dashboard').insertBefore(tiltEl, dom.byId('kpi-grid'));
    } else if (!tiltDetected && existingTiltEl) {
      existingTiltEl.remove();
    }
  }

  function bindEvents() {
    btnSyncGames = dom.byId('btn-sync');
    dom.byId('btn-review-latest').addEventListener('click', reviewLatestGame);
    dom.byId('recent-games-body').addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-open-game-id]');
      if (btn) onOpenGame(btn.dataset.openGameId);
    });
  }

  return {
    bindEvents,
    loadStats,
    reviewLatestGame,
  };
}
