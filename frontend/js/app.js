import { api, apiPost, apiPut, apiDelete, apiContract } from './modules/api.js';
import { createActionsView } from './modules/views/actions.js';
import { createNavigationView } from './modules/views/navigation.js';
import { initChartDefaults } from './modules/charts.js';
import { clearAllCaches } from './modules/cache.js';
import { loadSectionTemplate } from './modules/viewLoader.js';
import { createAuthGate } from './modules/auth.js';
import { maybeShowOnboarding } from './modules/onboarding.js';
// Lit-powered design primitives. Side-effect imports register the
// custom elements globally so any view can use them without per-view
// boilerplate.
import './components/cc-empty-state.js';
import './components/cc-skeleton.js';

// Register the service worker if the browser supports it. We register lazily
// so it never blocks first paint, and silently swallow errors — the app
// works fine without it; the worker is purely an offline + caching upgrade.
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch((err) => {
      console.warn('Service worker registration failed:', err);
    });
  });
}

if (typeof Chart === 'undefined') {
  document.body.innerHTML =
    '<div class="load-error">Chart library failed to load. Check your network connection.</div>';
}
initChartDefaults();
// ── STATE ──
let statsData = null;
let charts = {};

let navigationView;
let routedAfterAuth = false;
const boundViews = new Set();
const authGate = createAuthGate({ api, apiPost, toast });
const views = {
  actions: null,
  dashboard: null,
  games: null,
  review: null,
  mistakes: null,
  openings: null,
  drills: null,
  coach: null,
  reports: null,
};

function getActionsView() {
  if (!views.actions) {
    views.actions = createActionsView({
      api,
      apiContract,
      apiPost,
      onLogout: () => authGate.logout(),
      onReportReady: loadGameDetail,
      toast,
    });
  }
  return views.actions;
}

async function ensureView(name) {
  if (name === 'dashboard' && !views.dashboard) {
    const { createDashboardView } = await import('./modules/views/dashboard.js');
    views.dashboard = createDashboardView({
      api,
      apiContract,
      charts,
      destroyChart,
      getStatsData: () => statsData,
      onOpenCoach: () => showView('coach'),
      onOpenDrills: () => showView('drills'),
      onOpenGame: loadGameDetail,
      onOpenGames: () => showView('games'),
      onOpenMistakes: () => showView('mistakes'),
      onStatsLoaded: () => {
        views.coach?.updateContext?.();
        maybeShowOnboarding({ statsData, apiPost, toast });
      },
      setStatsData: (next) => {
        statsData = next;
      },
      toast,
    });
  } else if (name === 'games' && !views.games) {
    const { createGamesView } = await import('./modules/views/games.js');
    views.games = createGamesView({
      api,
      apiContract,
      loadGameDetail,
      toast,
    });
  } else if (name === 'review' && !views.review) {
    const { createReviewView } = await import('./modules/views/review.js');
    views.review = createReviewView({
      api,
      apiContract,
      apiPost,
      generateReport: getActionsView().generateReport,
      onAskCoach: (prompt) => views.coach?.draftQuestion?.(prompt),
      showView,
    });
  } else if (name === 'mistakes' && !views.mistakes) {
    const { createMistakesView } = await import('./modules/views/mistakes.js');
    views.mistakes = createMistakesView({
      api,
      charts,
      destroyChart,
      getStatsData: () => statsData,
      toast,
    });
  } else if (name === 'openings' && !views.openings) {
    const { createOpeningsView } = await import('./modules/views/openings.js');
    views.openings = createOpeningsView({
      api,
      apiContract,
      apiDelete,
      apiPost,
      apiPut,
      charts,
      destroyChart,
      toast,
    });
  } else if (name === 'drills' && !views.drills) {
    const { createDrillsView } = await import('./modules/views/drills.js');
    views.drills = createDrillsView({
      api,
      apiContract,
      apiPost,
      toast,
    });
  } else if (name === 'coach' && !views.coach) {
    const { createCoachView } = await import('./modules/views/coach.js');
    views.coach = createCoachView({
      apiPost,
      buildReviewCoachPrompt,
      getStatsData: () => statsData,
      showView,
      toast,
    });
  } else if (name === 'reports' && !views.reports) {
    const { createReportsView } = await import('./modules/views/reports.js');
    views.reports = createReportsView({
      api,
      apiPost,
      toast,
    });
  }
}

function ensureViewBound(viewName) {
  if (boundViews.has(viewName)) return;
  if (viewName === 'dashboard') {
    views.dashboard?.bindEvents();
    views.dashboard?.loadStats();
  } else if (viewName === 'games') {
    views.games?.bindEvents();
  } else if (viewName === 'mistakes') {
    views.mistakes?.bindEvents();
  } else if (viewName === 'openings') {
    views.openings?.bindEvents?.();
  } else if (viewName === 'drills') {
    views.drills?.bindEvents();
  } else if (viewName === 'coach') {
    views.coach?.bindEvents();
  } else if (viewName === 'reports') {
    views.reports?.bindEvents();
  }
  boundViews.add(viewName);
}

navigationView = createNavigationView({
  onBeforeEnter: async (viewName) => {
    await loadSectionTemplate(viewName);
    if (viewName === 'game-detail') await ensureView('review');
    else await ensureView(viewName);
    ensureViewBound(viewName);
  },
  onEnterCoach: () => views.coach?.init(),
  onEnterDrills: () => views.drills?.ensureLoaded(),
  onEnterGames: () => views.games?.ensureLoaded(),
  onEnterMistakes: () => views.mistakes?.load(),
  onEnterOpenings: () => views.openings?.load(),
  onEnterReports: () => views.reports?.load(),
  onOpenGameDetail: (gameId) => loadGameDetail(gameId),
});
getActionsView().bindEvents();
navigationView.bindEvents();
navigationView.restoreSidebarPreference();
authGate.init().then((session) => {
  updateAuthUi(session);
  if (!session?.auth_required || session?.authenticated) {
    routedAfterAuth = true;
    navigationView.syncFromRoute();
  }
});

window.addEventListener('app:auth-changed', (event) => {
  updateAuthUi(event.detail);
  if (event.detail?.authenticated || !event.detail?.auth_required) {
    reloadAfterAuth();
  }
});

window.addEventListener('app:auth-required', () => {
  authGate.requireLogin();
});

document.addEventListener('app:data-invalidated', (event) => {
  const scopes = event.detail?.scopes || [];
  if (scopes.includes('analytics') || scopes.includes('dashboard')) {
    views.dashboard?.loadStats({ force: true });
  }
});

function showView(name) {
  navigationView.showView(name);
}

function updateAuthUi(session = authGate.getSession()) {
  const logoutBtn = document.getElementById('btn-logout');
  if (logoutBtn) {
    logoutBtn.hidden = !(session?.auth_required && session?.authenticated);
  }
}

async function reloadAfterAuth() {
  clearAllCaches();
  statsData = null;
  if (!routedAfterAuth) {
    routedAfterAuth = true;
    navigationView.syncFromRoute();
    return;
  }

  const currentView = navigationView.getCurrentView?.() || 'dashboard';
  await navigationView.showView(currentView, { updateRoute: false });
  if (currentView === 'dashboard') {
    views.dashboard?.loadStats();
  } else if (currentView === 'mistakes') {
    views.mistakes?.load(true);
  } else if (currentView === 'openings') {
    views.openings?.load(true);
  } else if (currentView === 'drills') {
    views.drills?.loadDrills?.();
  } else if (currentView === 'games') {
    views.games?.loadGames?.();
  } else if (currentView === 'coach') {
    views.coach?.updateContext?.();
  }
}

// ── TOAST ──
function toast(msg, duration = 3000) {
  const el = document.createElement('div');
  el.className =
    'fixed bottom-6 right-6 z-[1000] rounded-cc border border-[var(--border)] bg-[var(--surface-2)] px-4 py-3 text-[13px] text-[var(--text)] shadow-cc-md';
  el.setAttribute('role', 'status');
  el.setAttribute('aria-live', 'polite');
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), duration);
}

function buildReviewCoachPrompt() {
  return views.review?.buildCoachPrompt?.() || '';
}

async function loadGameDetail(gameId) {
  await loadSectionTemplate('game-detail');
  await ensureView('review');
  return views.review.loadGameDetail(gameId);
}

// ── CHARTS ──
function destroyChart(id) {
  if (charts[id]) {
    charts[id].destroy();
    delete charts[id];
  }
}
// ── INIT ──
