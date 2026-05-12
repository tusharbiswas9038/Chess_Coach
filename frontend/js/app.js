import { api, apiPost, apiContract } from './modules/api.js';
import { createActionsView } from './modules/views/actions.js';
import { createCoachView } from './modules/views/coach.js';
import { createDashboardView } from './modules/views/dashboard.js';
import { createDrillsView } from './modules/views/drills.js';
import { createGamesView } from './modules/views/games.js';
import { createMistakesView } from './modules/views/mistakes.js';
import { createNavigationView } from './modules/views/navigation.js';
import { createOpeningsView } from './modules/views/openings.js';
import { createReviewView } from './modules/views/review.js';
import { initChartDefaults } from './modules/charts.js';
import { createPreferences } from './modules/preferences.js';

if (typeof Chart === 'undefined') {
  document.body.innerHTML =
    '<div class="load-error">Chart library failed to load. Check your network connection.</div>';
}
initChartDefaults();
// ── STATE ──
let statsData = null;
let charts = {};

let reviewView;
let navigationView;
const actionsView = createActionsView({
  api,
  apiContract,
  apiPost,
  onReportReady: loadGameDetail,
  toast,
});

const coachView = createCoachView({
  apiPost,
  buildReviewCoachPrompt,
  getStatsData: () => statsData,
  showView,
  toast,
});

const preferences = createPreferences({ toast });

reviewView = createReviewView({
  api,
  apiContract,
  generateReport: actionsView.generateReport,
  onAskCoach: (prompt) => coachView.draftQuestion(prompt),
  showView,
});

const gamesView = createGamesView({
  api,
  apiContract,
  loadGameDetail,
  toast,
});

const drillsView = createDrillsView({
  api,
  apiContract,
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
  apiContract,
  charts,
  destroyChart,
  toast,
});

const dashboardView = createDashboardView({
  api,
  apiContract,
  charts,
  destroyChart,
  getStatsData: () => statsData,
  onOpenGame: loadGameDetail,
  onOpenGames: () => showView('games'),
  onStatsLoaded: () => coachView.updateContext(),
  setStatsData: (next) => {
    statsData = next;
  },
  toast,
});

navigationView = createNavigationView({
  onEnterCoach: () => coachView.init(),
  onEnterDrills: () => drillsView.ensureLoaded(),
  onEnterGames: () => gamesView.ensureLoaded(),
  onEnterMistakes: () => mistakesView.load(),
  onEnterOpenings: () => openingsView.load(),
});

// __ BUTTONS __

document.getElementById('btn-view-all-games').addEventListener('click', () => showView('games'));
document.getElementById('btn-start-drills').addEventListener('click', () => showView('drills'));

document
  .querySelector('.back-btn')
  .addEventListener('click', () => showView('games'));

gamesView.bindEvents();
coachView.bindEvents();
drillsView.bindEvents();
mistakesView.bindEvents();
dashboardView.bindEvents();
actionsView.bindEvents();
navigationView.bindEvents();
navigationView.restoreSidebarPreference();
navigationView.syncFromRoute();
preferences.bindEvents();
preferences.init();

document.addEventListener('app:data-invalidated', (event) => {
  const scopes = event.detail?.scopes || [];
  if (scopes.includes('analytics') || scopes.includes('dashboard')) {
    dashboardView.loadStats({ force: true });
  }
});

function showView(name) {
  navigationView.showView(name);
}

// ── TOAST ──
function toast(msg, duration = 3000) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.setAttribute('role', 'status');
  el.setAttribute('aria-live', 'polite');
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), duration);
}

function buildReviewCoachPrompt() {
  return reviewView.buildCoachPrompt();
}

function loadGameDetail(gameId) {
  return reviewView.loadGameDetail(gameId);
}

// ── CHARTS ──
function destroyChart(id) {
  if (charts[id]) {
    charts[id].destroy();
    delete charts[id];
  }
}
// ── INIT ──
dashboardView.loadStats();
