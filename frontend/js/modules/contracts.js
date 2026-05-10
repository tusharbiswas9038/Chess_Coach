export const endpoints = {
  dashboardBootstrap: () => '/api/dashboard/bootstrap',
  stats: () => '/api/stats',
  weeklyFocus: () => '/api/product/weekly-focus',
  sessions: (limit = 1) => `/api/sessions?limit=${limit}`,
  gamesList: (query = '') => (query ? `/api/games?${query}` : '/api/games'),
  gameDetail: (gameId) => `/api/games/${gameId}`,
  gameCritical: (gameId) => `/api/games/${gameId}/critical`,
  mistakesByPhase: (phase = '') =>
    phase ? `/api/mistakes/by-phase?phase=${encodeURIComponent(phase)}` : '/api/mistakes/by-phase',
  blunderHeatmap: (phase = '') =>
    phase ? `/api/stats/blunder_heatmap?phase=${encodeURIComponent(phase)}` : '/api/stats/blunder_heatmap',
  criticalMistakes: (limit = 20, phase = '') =>
    phase
      ? `/api/mistakes/critical?limit=${limit}&phase=${encodeURIComponent(phase)}`
      : `/api/mistakes/critical?limit=${limit}`,
  weeklyMotifs: (limit = 3, phase = '') =>
    phase
      ? `/api/mistakes/weekly-motifs?limit=${limit}&phase=${encodeURIComponent(phase)}`
      : `/api/mistakes/weekly-motifs?limit=${limit}`,
  openingGenome: (eco, color) =>
    `/api/openings/genome?eco=${encodeURIComponent(eco)}&color=${encodeURIComponent(color)}`,
  openingsSummary: (limit = 300) => `/api/openings/summary?limit=${limit}`,
  coachChat: () => '/api/coach/chat',
  coachGame: (gameId) => `/api/coach/game/${gameId}`,
  jobStatus: () => '/api/jobs/status',
  jobSync: () => '/api/jobs/sync',
  jobAnalyze: () => '/api/jobs/analyze',
  jobDbMaintenance: () => '/api/jobs/db-maintenance',
  drillsResult: () => '/api/drills/result',
  drillsDue: (limit = 15) => `/api/drills/due?limit=${limit}`,
};

function fail(label, msg) {
  throw new Error(`${label} contract error: ${msg}`);
}

function expectObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail(label, 'expected object');
  }
  return value;
}

function expectArray(value, label) {
  if (!Array.isArray(value)) {
    fail(label, 'expected array');
  }
  return value;
}

export const normalize = {
  dashboardBootstrap(payload) {
    const p = expectObject(payload, 'dashboardBootstrap');
    const stats = expectObject(p.stats, 'dashboardBootstrap.stats');
    if (!stats.games || typeof stats.games !== 'object') {
      fail('dashboardBootstrap.stats', 'missing games');
    }
    if (!Array.isArray(stats.recent_games)) {
      fail('dashboardBootstrap.stats', 'missing recent_games array');
    }
    return {
      stats,
      weekly_focus: p.weekly_focus && typeof p.weekly_focus === 'object' ? p.weekly_focus : null,
      latest_session: p.latest_session && typeof p.latest_session === 'object' ? p.latest_session : null,
    };
  },

  stats(payload) {
    const p = expectObject(payload, 'stats');
    if (!p.games || typeof p.games !== 'object') fail('stats', 'missing games');
    if (!Array.isArray(p.recent_games)) fail('stats', 'missing recent_games array');
    if (!Array.isArray(p.weekly_stats)) fail('stats', 'missing weekly_stats array');
    return p;
  },

  weeklyFocus(payload) {
    const p = expectObject(payload, 'weeklyFocus');
    if (p.actions && !Array.isArray(p.actions)) {
      fail('weeklyFocus', 'actions must be array');
    }
    return p;
  },

  sessions(payload) {
    return expectArray(payload, 'sessions');
  },

  gamesList(payload) {
    if (Array.isArray(payload)) return payload;
    const p = expectObject(payload, 'gamesList');
    if (!Array.isArray(p.items)) fail('gamesList', 'items must be array');
    return p;
  },

  gameDetail(payload) {
    const p = expectObject(payload, 'gameDetail');
    if (!p.game || typeof p.game !== 'object') fail('gameDetail', 'missing game');
    if (!Array.isArray(p.moves)) fail('gameDetail', 'missing moves array');
    if (!Array.isArray(p.mistakes)) fail('gameDetail', 'missing mistakes array');
    return p;
  },

  openingGenome(payload) {
    const p = expectObject(payload, 'openingGenome');
    if (!p.winrate_by_ply || typeof p.winrate_by_ply !== 'object') {
      fail('openingGenome', 'missing winrate_by_ply');
    }
    return p;
  },

  openingsSummary(payload) {
    const items = expectArray(payload, 'openingsSummary');
    return items.map((item) => expectObject(item, 'openingsSummary.item'));
  },
};
