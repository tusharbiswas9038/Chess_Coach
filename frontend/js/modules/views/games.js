import {
  analysisStatusMarkup,
  colorBadge,
  esc,
  fmt,
  mistakeCountClass,
  resultBadge,
  tableStateRowMarkup,
  truncate,
} from '../ui.js';
import { createDomCache } from '../dom.js';
import { endpoints, normalize } from '../contracts.js';

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

export function createGamesView({ api, apiContract, toast, loadGameDetail }) {
  const dom = createDomCache();
  let gamesPage = 0;
  let totalGames = 0;
  let gamesLoaded = false;
  let gamesFilters = { ...DEFAULT_GAMES_FILTERS };
  let activeGamesPreset = '';
  let gamesSearchTimer = null;

  function writeFiltersToControls() {
    dom.byId('games-search').value = gamesFilters.search;
    dom.byId('games-opening').value = gamesFilters.opening;
    dom.byId('games-color').value = gamesFilters.color;
    dom.byId('games-result').value = gamesFilters.result;
    dom.byId('games-analyzed').value = gamesFilters.analyzed;
    dom.byId('games-journal').value = gamesFilters.hasJournal;
    dom.byId('games-min-mistakes').value = gamesFilters.minMistakes;
    dom.byId('games-sort').value = gamesFilters.sort;
  }

  function syncFiltersFromControls() {
    gamesFilters = {
      search: dom.byId('games-search').value.trim(),
      opening: dom.byId('games-opening').value.trim(),
      color: dom.byId('games-color').value,
      result: dom.byId('games-result').value,
      analyzed: dom.byId('games-analyzed').value,
      hasJournal: dom.byId('games-journal').value,
      minMistakes: dom.byId('games-min-mistakes').value,
      sort: dom.byId('games-sort').value,
    };
  }

  function updatePresetUI() {
    dom.queryAll('[data-preset]').forEach((btn) => {
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
    const tbody = dom.byId('all-games-body');
    tbody.innerHTML = tableStateRowMarkup('Loading games…', 8, { kind: 'loading' });

    const offset = gamesPage * PAGE_SIZE;
    let response;
    try {
      response = await apiContract(
        endpoints.gamesList(buildQuery()),
        normalize.gamesList,
        'gamesList'
      );
    } catch (e) {
      toast('Failed to load games');
      tbody.innerHTML = tableStateRowMarkup('Failed to load games', 8, { kind: 'error' });
      return;
    }

    const data = response.items || [];
    totalGames = response.total || 0;
    const start = totalGames === 0 ? 0 : offset + 1;
    const end = offset + data.length;
    const totalPages = Math.max(1, Math.ceil(totalGames / PAGE_SIZE));

    dom.byId('btn-prev').disabled = gamesPage === 0;
    dom.byId('btn-next').disabled = end >= totalGames;
    dom.byId('page-label').textContent = `Page ${gamesPage + 1} / ${totalPages}`;
    dom.byId('games-count-label').textContent =
      totalGames > 0
        ? `Showing ${start}–${end} of ${totalGames}`
        : 'No games found';
    dom.byId('games-filter-summary').textContent =
      currentFilterSummary();

    if (data.length === 0) {
      tbody.innerHTML = tableStateRowMarkup('No games match the current filters', 8);
      return;
    }

    tbody.innerHTML = data
      .map(
        (g) => `
    <tr>
      <td data-label="Date">${fmt(g.date)}</td>
      <td data-label="Color">${colorBadge(g.color)}</td>
      <td data-label="Result">${resultBadge(g.result)}</td>
      <td data-label="Opponent" class="cell-strong">${esc(g.opponent_rating) || '?'}</td>
      <td data-label="Opening">
        <span class="opening-pill">${esc(g.opening_eco) || '?'}</span>
        ${truncate(g.opening_name, 28)}
      </td>
      <td data-label="Mistakes">
        <span class="${mistakeCountClass(g.mistake_count)}">
          ${g.mistake_count}
        </span>
      </td>
      <td data-label="Status">${analysisStatusMarkup(g.analyzed)}</td>
      <td data-label="Action"><button class="btn btn-ghost btn-table-action" type="button" data-open-game-id="${g.id}">Review</button></td>
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
    dom.byId('all-games-body').addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-open-game-id]');
      if (btn) loadGameDetail(btn.dataset.openGameId);
    });
    dom.byId('btn-prev').addEventListener('click', () => changePage(-1));
    dom.byId('btn-next').addEventListener('click', () => changePage(1));
    dom.byId('btn-clear-games-filters').addEventListener('click', clearFilters);
    dom.byId('games-preset-row')?.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-preset]');
      if (!btn) return;
      applyPreset(btn.dataset.preset);
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
      dom.byId(id).addEventListener('change', handleFilterChange);
    });

    ['games-search', 'games-opening'].forEach((id) => {
      dom.byId(id).addEventListener('input', handleFilterInput);
    });
  }

  return {
    bindEvents,
    changePage,
    ensureLoaded,
    loadGames,
  };
}
