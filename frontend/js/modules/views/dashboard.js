import {
  colorBadge,
  esc,
  fmt,
  mistakeCountClass,
  resultBadge,
  setBadgeCount,
  statePanelMarkup,
  tableStateRowMarkup,
  truncate,
} from '../ui.js';
import { createDomCache } from '../dom.js';
import { endpoints, normalize } from '../contracts.js';
import { createCache } from '../cache.js';
import { baseCartesianOptions, chartPalette, doughnutOptions } from '../charts.js';
import { createDashboardMotifsView } from './dashboard-motifs.js';
import { createDashboardInsightsView } from './dashboard-insights.js';

export function createDashboardView({
  api,
  apiContract,
  charts,
  destroyChart,
  getStatsData,
  onOpenCoach,
  onOpenDrills,
  onOpenGame,
  onOpenGames,
  onOpenMistakes,
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
  let nextStepTargets = { primary: 'drills', secondary: 'games' };
  function setChartMeta(id, text) {
    const el = dom.byId(id);
    if (el) el.textContent = text;
  }

  function drillSummaryFromStats(summary = null) {
    return summary || getStatsData()?.drill_summary || {
      goal_target: 5,
      today: { done: 0 },
      streak: 0,
    };
  }

  function updateDrillProgressKpi(summary = null) {
    const drillSummary = drillSummaryFromStats(summary);
    const goalTarget = Number(drillSummary.goal_target) || 5;
    const todayDone = Number(drillSummary.today?.done) || 0;
    const streak = Number(drillSummary.streak) || 0;
    const achievement =
      streak >= 10 ? 'On Fire' : streak >= 5 ? 'Consistent' : streak >= 2 ? 'Starter' : 'New';
    const goalEl = dom.byId('kpi-drill-goal-value');
    const streakEl = dom.byId('kpi-streak-value');
    const achievementEl = dom.byId('kpi-streak-sub');
    if (goalEl) goalEl.textContent = `${todayDone}/${goalTarget}`;
    if (streakEl) streakEl.textContent = `${streak} day${streak === 1 ? '' : 's'}`;
    if (achievementEl) achievementEl.textContent = achievement;
  }

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
          <li class="focus-action-item rounded-cc border border-[var(--border)] bg-[var(--surface-2)] px-3 py-2 text-sm ${isChecked ? 'is-done border-[var(--primary)]/35 bg-[color-mix(in_srgb,var(--primary)_12%,var(--surface-2))]' : ''}" data-action-index="${idx}">
            <label class="focus-action-label flex cursor-pointer items-start gap-2">
              <input class="checkbox checkbox-xs mt-[2px] border-[var(--border)]" type="checkbox" ${isChecked ? 'checked' : ''} />
              <span class="leading-snug">${esc(action)}</span>
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

  function buildNextSteps(statsData, weeklyFocus = null) {
    const dueCount = Number(statsData?.drills_due || 0);
    const pending = Number(statsData?.games?.pending || 0);
    const hRate = Number(statsData?.hanging_piece_rate || 0) * 100;
    const bpg = Number(statsData?.blunders_per_game || 0);
    const primaryFocus = weeklyFocus?.primary_focus;
    const focusType = primaryFocus?.type ? primaryFocus.type.replace('_', ' ') : null;
    const focusPhase = primaryFocus?.phase || 'all phases';

    const candidates = [];
    if (dueCount > 0) {
      candidates.push({
        title: `Clear ${Math.min(dueCount, 15)} due drill${dueCount === 1 ? '' : 's'}`,
        rationale:
          dueCount > 10
            ? 'Your review queue is large enough to block new learning. Finish the due items first.'
            : 'Spaced-repetition positions are time-sensitive and come from your own mistakes.',
        target: 'drills',
        score: 100 + dueCount,
        badge: 'Drills',
      });
    }
    if (primaryFocus) {
      candidates.push({
        title: `Attack ${focusType} in ${focusPhase}`,
        rationale: weeklyFocus?.actions?.[0] || 'This is the strongest current pattern in your recent games.',
        target: 'mistakes',
        score: 86,
        badge: 'Focus',
      });
    }
    if (hRate >= 40) {
      candidates.push({
        title: 'Run a piece-safety review',
        rationale: `${hRate.toFixed(1)}% hanging-piece rate is high enough to cost games before strategy matters.`,
        target: 'mistakes',
        score: 82,
        badge: 'Leak',
      });
    }
    if (bpg >= 3) {
      candidates.push({
        title: 'Practice a one-move blunder check',
        rationale: `${bpg.toFixed(1)} blunders per game means the fastest gain is reducing one tactical miss.`,
        target: 'drills',
        score: 78,
        badge: 'Tactics',
      });
    }
    if (pending > 0) {
      candidates.push({
        title: `Analyze ${pending} pending game${pending === 1 ? '' : 's'}`,
        rationale: 'The dashboard is missing fresh signals from games that are already in the database.',
        target: 'games',
        score: 62 + Math.min(pending, 20),
        badge: 'Backlog',
      });
    }
    candidates.push({
      title: 'Review the latest critical game',
      rationale: 'One concrete mistake reviewed deeply is better than scanning ten games loosely.',
      target: 'games',
      score: 50,
      badge: 'Review',
    });
    candidates.push({
      title: 'Ask coach for one correction rule',
      rationale: 'Convert the pattern into a short rule you can use before your next game.',
      target: 'coach',
      score: 42,
      badge: 'Coach',
    });

    return candidates
      .sort((a, b) => b.score - a.score)
      .filter((step, index, arr) => arr.findIndex((item) => item.title === step.title) === index)
      .slice(0, 3);
  }

  function renderNextBestStep(statsData, weeklyFocus = null) {
    const steps = buildNextSteps(statsData, weeklyFocus);
    const list = dom.byId('next-step-list');
    const badge = dom.byId('next-step-badge');
    const subtitle = dom.byId('next-step-subtitle');
    const primaryBtn = dom.byId('btn-next-step-action');
    const secondaryBtn = dom.byId('btn-next-step-secondary');
    if (!list || !steps.length) return;

    nextStepTargets = {
      primary: steps[0]?.target || 'drills',
      secondary: steps[1]?.target || 'games',
    };
    badge.textContent = steps[0]?.badge || 'Ready';
    subtitle.textContent = `Top action selected from ${steps.length} current signal${steps.length === 1 ? '' : 's'}.`;
    primaryBtn.textContent =
      nextStepTargets.primary === 'drills'
        ? 'Start Drills'
        : nextStepTargets.primary === 'coach'
          ? 'Ask Coach'
          : nextStepTargets.primary === 'mistakes'
            ? 'Open Mistakes'
            : 'Review Games';
    secondaryBtn.textContent =
      nextStepTargets.secondary === 'coach'
        ? 'Coach'
        : nextStepTargets.secondary === 'mistakes'
          ? 'Mistakes'
          : nextStepTargets.secondary === 'drills'
            ? 'Drills'
            : 'Games';

    list.innerHTML = steps
      .map(
        (step, idx) => `
          <div class="next-step-item flex items-start gap-3 rounded-cc border border-[var(--border)] bg-[var(--surface)] p-3 transition-colors ${idx === 0 ? 'is-primary border-[var(--primary)]/40 bg-[color-mix(in_srgb,var(--primary)_11%,var(--surface))]' : ''}">
            <div class="next-step-rank inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-[var(--border)] bg-[var(--surface-2)] text-xs font-semibold text-[var(--muted)]">${idx + 1}</div>
            <div class="next-step-copy min-w-0">
              <div class="next-step-title text-sm font-semibold text-[var(--text)]">${esc(step.title)}</div>
              <div class="next-step-rationale mt-1 text-xs text-[var(--muted)]">${esc(step.rationale)}</div>
            </div>
          </div>
        `
      )
      .join('');
  }

  function renderSessionFlow(statsData, latestSession = null) {
    const drillSummary = drillSummaryFromStats(statsData?.drill_summary);
    const goalTarget = Number(drillSummary.goal_target) || 5;
    const todayDone = Number(drillSummary.today?.done) || 0;
    const dueCount = Number(statsData?.drills_due || 0);
    const recentGames = statsData?.recent_games?.length || 0;
    const tiltDetected = Boolean(latestSession?.tilt_detected);

    const warmupState = todayDone > 0 ? `${todayDone}/${goalTarget}` : dueCount > 0 ? 'Ready' : 'Light';
    const reviewState = recentGames > 0 ? 'Ready' : 'No games';
    const drillState = dueCount > 0 ? `${dueCount} due` : 'Clear';
    const coachState = tiltDetected ? 'Recommended' : 'Optional';

    dom.byId('session-step-warmup').textContent = warmupState;
    dom.byId('session-step-review').textContent = reviewState;
    dom.byId('session-step-drill').textContent = drillState;
    dom.byId('session-step-coach').textContent = coachState;

    dom.query('[data-flow-step="warmup"]')?.classList.toggle('is-done', todayDone >= goalTarget);
    dom.query('[data-flow-step="review"]')?.classList.toggle('is-muted', recentGames === 0);
    dom.query('[data-flow-step="drill"]')?.classList.toggle('is-active', dueCount > 0);
    dom.query('[data-flow-step="coach"]')?.classList.toggle('is-active', tiltDetected);
  }

  function openTarget(target) {
    if (target === 'drills') onOpenDrills?.();
    else if (target === 'coach') onOpenCoach?.();
    else if (target === 'mistakes') onOpenMistakes?.();
    else onOpenGames();
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
    renderNextBestStep(statsData, weeklyFocus);
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
              chartPalette.analyticsSoft,
            ],
            borderColor: [chartPalette.error, chartPalette.warning, chartPalette.analytics],
            borderWidth: 1,
          },
        ],
      },
      options: doughnutOptions({ legendPosition: 'right' }),
    });
  }

  const motifsView = createDashboardMotifsView({
    dom,
    onOpenGame: (gameId) => onOpenGame(gameId),
  });

  const insightsView = createDashboardInsightsView({
    dom,
    fetchInsights: () =>
      cache.getOrSet(
        'dashboard:insights',
        () => fetchContract(endpoints.insightsLatest(), normalize.insightsLatest, 'insightsLatest'),
        60000
      ),
  });

  function renderDashboardMotifs(payload) {
    motifsView.render(payload);
  }

  function renderInsights(insights) {
    insightsView.render(insights);
  }

  function renderInsightSlices(insights) {
    insightsView.renderSlices(insights);
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
    setChartMeta('chart-winrate-meta', 'Refreshing…');
    setChartMeta('chart-mistakes-meta', 'Refreshing…');
    dom.byId('kpi-grid').innerHTML = Array.from({ length: 5 })
      .map(
        () => `
      <div class="kpi-card p-4">
        <div class="skeleton h-3 w-[42%] mb-[10px] rounded-[var(--radius)]"></div>
        <div class="skeleton h-[30px] w-[56%] mb-[10px] rounded-[var(--radius)]"></div>
        <div class="skeleton h-3 w-[74%] rounded-[var(--radius)]"></div>
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
    let insights = null;
    let motifs = null;

    try {
      const [bootstrap, insightsResult, motifsResult] = await Promise.all([
        cache.getOrSet(
        'dashboard:bootstrap',
        () =>
          fetchContract(
            endpoints.dashboardBootstrap(),
            normalize.dashboardBootstrap,
            'dashboardBootstrap'
          ),
        20000
        ),
        cache.getOrSet(
          'dashboard:insights',
          () => fetchContract(endpoints.insightsLatest(), normalize.insightsLatest, 'insightsLatest'),
          60000
        ).catch((e) => {
          console.warn('Insights snapshot unavailable:', e);
          return null;
        }),
        cache.getOrSet(
          'dashboard:motifs',
          () => api(endpoints.motifsLatest(5)),
          60000
        ).catch((e) => {
          console.warn('Motifs snapshot unavailable:', e);
          return null;
        }),
      ]);
      statsData = bootstrap.stats;
      weeklyFocus = bootstrap.weekly_focus;
      latestSession = bootstrap.latest_session;
      insights = insightsResult;
      motifs = motifsResult;
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
    renderInsights(insights);
    renderDashboardMotifs(motifs);
    renderSessionFlow(statsData, latestSession);
    dom.byId('btn-review-latest').disabled =
      !statsData.recent_games.length;

    onStatsLoaded();

    const hRate = (statsData.hanging_piece_rate * 100).toFixed(1);
    const bpg = statsData.blunders_per_game;
    const analyzed = statsData.games.analyzed;
    const total = statsData.games.total;

    const drillSummary = drillSummaryFromStats(statsData.drill_summary);
    const goalTarget = Number(drillSummary.goal_target) || 5;
    const todayDone = Number(drillSummary.today?.done) || 0;
    const streak = Number(drillSummary.streak) || 0;
    const achievement =
      streak >= 10 ? 'On Fire' : streak >= 5 ? 'Consistent' : streak >= 2 ? 'Starter' : 'New';

    dom.byId('kpi-grid').innerHTML = `
    <div class="kpi-card p-4">
      <div class="mb-2 text-lg text-[var(--analytics)]">▣</div>
      <div class="kpi-label text-xs font-medium uppercase tracking-wide text-[var(--muted)]">Games Analyzed</div>
      <div class="kpi-value kpi-blue mt-2 text-2xl font-semibold">${analyzed.toLocaleString()}</div>
      <div class="kpi-sub mt-1 text-xs text-[var(--muted)]">${total} total, ${
  statsData.games.pending
} pending</div>
    </div>
    <div class="kpi-card p-4">
      <div class="mb-2 text-lg text-[var(--error)]">!</div>
      <div class="kpi-label text-xs font-medium uppercase tracking-wide text-[var(--muted)]">Hanging Piece Rate</div>
      <div class="kpi-value kpi-bad mt-2 text-2xl font-semibold">${hRate}%</div>
      <div class="kpi-sub mt-1 text-xs text-[var(--muted)]">pieces left en prise</div>
    </div>
    <div class="kpi-card p-4">
      <div class="mb-2 text-lg text-[var(--warning)]">△</div>
      <div class="kpi-label text-xs font-medium uppercase tracking-wide text-[var(--muted)]">Blunders / Game</div>
      <div class="kpi-value kpi-bad mt-2 text-2xl font-semibold">${bpg}</div>
      <div class="kpi-sub mt-1 text-xs text-[var(--muted)]">target: below 3</div>
    </div>
    <div class="kpi-card p-4">
      <div class="mb-2 text-lg text-[var(--primary)]">↗</div>
      <div class="kpi-label text-xs font-medium uppercase tracking-wide text-[var(--muted)]">Current Win Rate</div>
      <div class="kpi-value kpi-good mt-2 text-2xl font-semibold">${
  statsData.weekly_stats[0]
    ? statsData.weekly_stats[0].win_pct + '%'
    : '—'
}</div>
      <div class="kpi-sub mt-1 text-xs text-[var(--muted)]">this week</div>
    </div>
    <div class="kpi-card p-4">
      <div class="mb-2 text-lg text-[var(--primary)]">✓</div>
      <div class="kpi-label text-xs font-medium uppercase tracking-wide text-[var(--muted)]">Drill Goal</div>
      <div class="kpi-value kpi-good mt-2 text-2xl font-semibold" id="kpi-drill-goal-value">${todayDone}/${goalTarget}</div>
      <div class="kpi-sub mt-1 text-xs text-[var(--muted)]">daily target progress</div>
    </div>
    <div class="kpi-card p-4">
      <div class="mb-2 text-lg text-[var(--analytics)]">◆</div>
      <div class="kpi-label text-xs font-medium uppercase tracking-wide text-[var(--muted)]">Streak / Achievement</div>
      <div class="kpi-value kpi-blue mt-2 text-2xl font-semibold" id="kpi-streak-value">${streak} day${streak === 1 ? '' : 's'}</div>
      <div class="kpi-sub mt-1 text-xs text-[var(--muted)]" id="kpi-streak-sub">${achievement}</div>
    </div>
    <div class="kpi-card p-4">
      <div class="mb-2 text-lg text-[var(--warning)]">◍</div>
      <div class="kpi-label text-xs font-medium uppercase tracking-wide text-[var(--muted)]">Total Mistakes</div>
      <div class="kpi-value kpi-warn mt-2 text-2xl font-semibold">${statsData.mistake_breakdown
    .reduce((a, m) => a + m.count, 0)
    .toLocaleString()}</div>
      <div class="kpi-sub mt-1 text-xs text-[var(--muted)]">across all analyzed games</div>
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
      setChartMeta('chart-winrate-meta', 'Updated now');
      setChartMeta('chart-mistakes-meta', 'Updated now');
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
      <td data-label="Opening"><span class="opening-pill badge badge-outline badge-sm">${esc(g.opening_eco) || '?'}</span> ${truncate(
  g.opening_name,
  30
)}</td>
      <td data-label="Mistakes"><span class="${mistakeCountClass(g.mistake_count)}">${g.mistake_count}</span></td>
      <td data-label="Action"><button class="btn btn-ghost btn-sm min-h-[44px] whitespace-nowrap px-[10px] text-xs" type="button" data-open-game-id="${g.id}">Review</button></td>
    </tr>
  `
      )
      .join('');

    renderWinRateChart(statsData);
    renderMistakeBreakdownChart(statsData);
    setChartMeta('chart-winrate-meta', 'Updated now');
    setChartMeta('chart-mistakes-meta', 'Updated now');
  }

  function renderTiltWarning(tiltDetected) {
    const existingTiltEl = dom.byId('tilt-warning');
    if (tiltDetected && !existingTiltEl) {
      const tiltEl = document.createElement('div');
      tiltEl.className =
        'mb-5 flex items-center gap-3 rounded-cc border border-[rgba(210,153,34,0.3)] bg-[rgba(210,153,34,0.1)] px-[18px] py-[14px] text-[13px]';
      tiltEl.innerHTML = `
        <span class="text-[20px]" aria-hidden="true">!</span>
        <div>
          <strong class="text-[var(--warning)]">Tilt Warning</strong>
          <div class="mt-[2px] text-xs text-[var(--muted)]">
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

  const FOCUS_PREF_KEY = 'cc.dashboard.focus';

  function readFocusPref() {
    // Default ON for new users so the first impression is calm. Users who
    // explicitly toggle it off have their choice persisted; everyone else
    // gets the curated four-section above-the-fold.
    try {
      const raw = window.localStorage.getItem(FOCUS_PREF_KEY);
      if (raw === null) return true;
      return raw === '1';
    } catch (_) {
      return true;
    }
  }

  function writeFocusPref(enabled) {
    try {
      window.localStorage.setItem(FOCUS_PREF_KEY, enabled ? '1' : '0');
    } catch (_) {
      // ignore
    }
  }

  function applyFocusMode(enabled) {
    document.body.classList.toggle('dashboard-focused', !!enabled);
  }

  function setupFocusToggle() {
    const initial = readFocusPref();
    applyFocusMode(initial);
    const checkbox = dom.byId('dashboard-focus-toggle');
    if (!checkbox) return;
    checkbox.checked = initial;
    checkbox.addEventListener('change', () => {
      const next = !!checkbox.checked;
      applyFocusMode(next);
      writeFocusPref(next);
    });
  }

  function bindEvents() {
    btnSyncGames = dom.byId('btn-sync');
    setupFocusToggle();
    dom.byId('btn-review-latest').addEventListener('click', reviewLatestGame);
    dom.byId('btn-next-step-action')?.addEventListener('click', () => {
      openTarget(nextStepTargets.primary);
    });
    dom.byId('btn-next-step-secondary')?.addEventListener('click', () => {
      openTarget(nextStepTargets.secondary);
    });
    dom.byId('session-flow-steps')?.addEventListener('click', (e) => {
      const step = e.target.closest('[data-target-view]');
      if (!step) return;
      openTarget(step.dataset.targetView);
    });
    insightsView.bindEvents();
    dom.byId('recent-games-body').addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-open-game-id]');
      if (btn) onOpenGame(btn.dataset.openGameId);
    });
    motifsView.bindEvents();
    document.addEventListener('drills:progress-updated', (event) => {
      const current = getStatsData();
      if (current && event.detail) {
        current.drill_summary = event.detail;
        current.drills_due = Number(event.detail.due_total || 0);
        current.due_drills_warning = current.drills_due > 10;
        setBadgeCount(dom.byId('drill-badge'), current.drills_due);
      }
      updateDrillProgressKpi(event.detail);
    });
  }

  return {
    bindEvents,
    loadStats,
    reviewLatestGame,
  };
}
