import {
  analysisStatusMarkup,
  colorBadge,
  esc,
  fmt,
  mistakeCountClass,
  resultBadge,
  truncate,
} from '../ui.js';

const PAGE_SIZE = 30;

const DEFAULT_GAMES_FILTERS = {
  search: '',
  opening: '',
  color: '',
  result: '',
  analyzed: '',
  hasJournal: '',
  minMistakes: '0',
  sort: 'date_desc',
};

export function createGamesView({ api, toast, loadGameDetail }) {
  let gamesPage = 0;
  let totalGames = 0;
  let gamesLoaded = false;
  let gamesFilters = { ...DEFAULT_GAMES_FILTERS };
  let activeGamesPreset = '';
  let gamesSearchTimer = null;

  function writeFiltersToControls() {
    document.getElementById('games-search').value = gamesFilters.search;
    document.getElementById('games-opening').value = gamesFilters.opening;
    document.getElementById('games-color').value = gamesFilters.color;
    document.getElementById('games-result').value = gamesFilters.result;
    document.getElementById('games-analyzed').value = gamesFilters.analyzed;
    document.getElementById('games-journal').value = gamesFilters.hasJournal;
    document.getElementById('games-min-mistakes').value = gamesFilters.minMistakes;
    document.getElementById('games-sort').value = gamesFilters.sort;
  }

  function syncFiltersFromControls() {
    gamesFilters = {
      search: document.getElementById('games-search').value.trim(),
      opening: document.getElementById('games-opening').value.trim(),
      color: document.getElementById('games-color').value,
      result: document.getElementById('games-result').value,
      analyzed: document.getElementById('games-analyzed').value,
      hasJournal: document.getElementById('games-journal').value,
      minMistakes: document.getElementById('games-min-mistakes').value,
      sort: document.getElementById('games-sort').value,
    };
  }

  function updatePresetUI() {
    document.querySelectorAll('[data-preset]').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.preset === activeGamesPreset);
    });
  }

  function currentFilterSummary() {
    const parts = [];
    if (gamesFilters.search) parts.push(`search "${gamesFilters.search}"`);
    if (gamesFilters.opening) parts.push(`opening "${gamesFilters.opening}"`);
    if (gamesFilters.color) parts.push(gamesFilters.color);
    if (gamesFilters.result) parts.push(gamesFilters.result);
    if (gamesFilters.analyzed === '1') parts.push('analyzed');
    if (gamesFilters.analyzed === '0') parts.push('pending');
    if (gamesFilters.analyzed === '2') parts.push('errors');
    if (gamesFilters.hasJournal === '0') parts.push('missing coach note');
    if (gamesFilters.hasJournal === '1') parts.push('has coach note');
    if (gamesFilters.minMistakes !== '0') parts.push(`${gamesFilters.minMistakes}+ mistakes`);
    return parts.length ? parts.join(' · ') : 'All games';
  }

  function buildQuery() {
    const params = new URLSearchParams({
      limit: String(PAGE_SIZE),
      offset: String(gamesPage * PAGE_SIZE),
      return_total: 'true',
      sort: gamesFilters.sort || DEFAULT_GAMES_FILTERS.sort,
    });

    if (gamesFilters.search) params.set('search', gamesFilters.search);
    if (gamesFilters.opening) params.set('opening', gamesFilters.opening);
    if (gamesFilters.color) params.set('color', gamesFilters.color);
    if (gamesFilters.result) params.set('result', gamesFilters.result);
    if (gamesFilters.analyzed) params.set('analyzed', gamesFilters.analyzed);
    if (gamesFilters.hasJournal) {
      params.set('has_journal', gamesFilters.hasJournal === '1' ? 'true' : 'false');
    }
    if (gamesFilters.minMistakes && gamesFilters.minMistakes !== '0') {
      params.set('min_mistakes', gamesFilters.minMistakes);
    }

    return params.toString();
  }

  async function loadGames() {
    const offset = gamesPage * PAGE_SIZE;
    let response;
    try {
      response = await api(`/api/games?${buildQuery()}`);
    } catch (e) {
      toast('Failed to load games');
      return;
    }

    const data = response.items || [];
    totalGames = response.total || 0;
    const start = totalGames === 0 ? 0 : offset + 1;
    const end = offset + data.length;
    const totalPages = Math.max(1, Math.ceil(totalGames / PAGE_SIZE));

    document.getElementById('btn-prev').disabled = gamesPage === 0;
    document.getElementById('btn-next').disabled = end >= totalGames;
    document.getElementById('page-label').textContent = `Page ${gamesPage + 1} / ${totalPages}`;
    document.getElementById('games-count-label').textContent =
      totalGames > 0
        ? `Showing ${start}–${end} of ${totalGames}`
        : 'No games found';
    document.getElementById('games-filter-summary').textContent =
      currentFilterSummary();

    const tbody = document.getElementById('all-games-body');
    if (data.length === 0) {
      tbody.innerHTML =
        '<tr><td colspan="7"><div class="empty"><div class="empty-icon">♟</div>No games match the current filters</div></td></tr>';
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

  function applyFilters() {
    syncFiltersFromControls();
    gamesPage = 0;
    loadGames();
  }

  function handleFilterChange() {
    activeGamesPreset = '';
    updatePresetUI();
    applyFilters();
  }

  function handleFilterInput() {
    activeGamesPreset = '';
    updatePresetUI();
    clearTimeout(gamesSearchTimer);
    gamesSearchTimer = setTimeout(() => {
      applyFilters();
    }, 220);
  }

  function clearFilters() {
    activeGamesPreset = '';
    gamesFilters = { ...DEFAULT_GAMES_FILTERS };
    writeFiltersToControls();
    updatePresetUI();
    gamesPage = 0;
    loadGames();
  }

  function applyPreset(name) {
    const presets = {
      'recent-losses': {
        result: 'loss',
        sort: 'date_desc',
      },
      'high-mistakes': {
        analyzed: '1',
        minMistakes: '5',
        sort: 'mistakes_desc',
      },
      'needs-coach': {
        analyzed: '1',
        hasJournal: '0',
        sort: 'date_desc',
      },
      'strong-opponents': {
        analyzed: '1',
        sort: 'opponent_desc',
      },
    };
    activeGamesPreset = activeGamesPreset === name ? '' : name;
    gamesFilters = activeGamesPreset
      ? { ...DEFAULT_GAMES_FILTERS, ...(presets[activeGamesPreset] || {}) }
      : { ...DEFAULT_GAMES_FILTERS };
    writeFiltersToControls();
    updatePresetUI();
    gamesPage = 0;
    loadGames();
  }

  function changePage(dir) {
    if (dir === -1 && gamesPage === 0) return;
    gamesPage += dir;
    loadGames();
  }

  function ensureLoaded() {
    if (gamesLoaded) return;
    gamesLoaded = true;
    loadGames();
  }

  function bindEvents() {
    document.getElementById('all-games-body').addEventListener('click', (e) => {
      const row = e.target.closest('tr[data-game-id]');
      if (row) loadGameDetail(row.dataset.gameId);
    });
    document.getElementById('btn-prev').addEventListener('click', () => changePage(-1));
    document.getElementById('btn-next').addEventListener('click', () => changePage(1));
    document
      .getElementById('btn-clear-games-filters')
      .addEventListener('click', clearFilters);
    document.querySelectorAll('[data-preset]').forEach((btn) => {
      btn.addEventListener('click', () => applyPreset(btn.dataset.preset));
    });

    [
      'games-opening',
      'games-color',
      'games-result',
      'games-analyzed',
      'games-journal',
      'games-min-mistakes',
      'games-sort',
    ].forEach((id) => {
      document.getElementById(id).addEventListener('change', handleFilterChange);
    });

    ['games-search', 'games-opening'].forEach((id) => {
      document.getElementById(id).addEventListener('input', handleFilterInput);
    });
  }

  return {
    bindEvents,
    changePage,
    ensureLoaded,
    loadGames,
  };
}
