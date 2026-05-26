export const endpoints = {
  authSession: () => '/api/auth/session',
  authLogin: () => '/api/auth/login',
  authLogout: () => '/api/auth/logout',
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
  jobPlayerModel: () => '/api/jobs/player-model',
  jobDbMaintenance: () => '/api/jobs/db-maintenance',
  playerModelLatest: () => '/api/product/player-model/latest',
  drillsResult: () => '/api/drills/result',
  drillsDue: (limit = 15, refresh = false, mode = 'adaptive', motif = '') =>
    `/api/drills/due?limit=${limit}${refresh ? '&refresh=true' : ''}&mode=${encodeURIComponent(mode)}${motif ? `&motif=${encodeURIComponent(motif)}` : ''}`,
  drillsSummary: () => '/api/drills/summary',
  drillsGeneratePuzzles: () => '/api/drills/generate-puzzles',
  drillsPuzzleSummary: () => '/api/drills/puzzles/summary',
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

  jobStatus(payload) {
    const p = expectObject(payload, 'jobStatus');
    const recent = Array.isArray(p.recent_jobs) ? p.recent_jobs : [];
    return {
      ...p,
      status: String(p.status || 'unknown'),
      queue_size: Number(p.queue_size || 0),
      queue_max_size: Number(p.queue_max_size || 0),
      worker_running: Boolean(p.worker_running),
      recent_jobs: recent.map((job) => ({
        ...expectObject(job, 'jobStatus.recent_jobs.item'),
        id: String(job.id || ''),
        status: String(job.status || 'unknown'),
        finished_at: Number(job.finished_at || 0),
        invalidates: Array.isArray(job.invalidates) ? job.invalidates : [],
      })),
    };
  },

  playerModel(payload) {
    const p = expectObject(payload, 'playerModel');
    if (p.status === 'empty') return p;
    if (!p.summary || typeof p.summary !== 'object') {
      fail('playerModel', 'missing summary');
    }
    if (!p.payload || typeof p.payload !== 'object') {
      fail('playerModel', 'missing payload');
    }
    return p;
  },

  drillsDue(payload) {
    return expectArray(payload, 'drillsDue').map((item) => expectObject(item, 'drillsDue.item'));
  },

  drillsSummary(payload) {
    const p = expectObject(payload, 'drillsSummary');
    const today = p.today && typeof p.today === 'object' ? p.today : {};
    return {
      due_total: Number(p.due_total || 0),
      session_limit: Number(p.session_limit || 15),
      goal_target: Number(p.goal_target || 5),
      today: {
        date: String(today.date || ''),
        done: Number(today.done || 0),
        correct: Number(today.correct || 0),
        wrong: Number(today.wrong || 0),
        goal_done: Boolean(today.goal_done),
      },
      streak: Number(p.streak || 0),
    };
  },

  drillsPuzzleSummary(payload) {
    const p = expectObject(payload, 'drillsPuzzleSummary');
    return {
      total: Number(p.total || 0),
      difficulty: p.difficulty && typeof p.difficulty === 'object' ? p.difficulty : {},
      motifs: Array.isArray(p.motifs) ? p.motifs.map((item) => expectObject(item, 'drillsPuzzleSummary.motif')) : [],
      phases: Array.isArray(p.phases) ? p.phases.map((item) => expectObject(item, 'drillsPuzzleSummary.phase')) : [],
    };
  },
};
