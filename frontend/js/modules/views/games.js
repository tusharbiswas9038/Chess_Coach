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
const FILTER_SLOT_KEY = 'games.filters.slots.v1';

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
  let lastLoadedGames = [];

  function readFiltersFromUrl() {
    const params = new URLSearchParams(window.location.search);
    if (![...params.keys()].length) return null;
    const next = { ...DEFAULT_GAMES_FILTERS };
    const fields = ['search', 'opening', 'color', 'result', 'analyzed', 'sort'];
    fields.forEach((k) => {
      if (params.has(k)) next[k] = params.get(k) || '';
    });
    if (params.has('hasJournal')) next.hasJournal = params.get('hasJournal') || '';
    if (params.has('has_journal')) next.hasJournal = params.get('has_journal') || '';
    if (params.has('minMistakes')) next.minMistakes = params.get('minMistakes') || '0';
    if (params.has('min_mistakes')) next.minMistakes = params.get('min_mistakes') || '0';
    return next;
  }

  function syncUrlFromFilters() {
    // Only update URL when on the games view; avoid clobbering other pages.
    if (!window.location.pathname.replace(/^\/+/, '').startsWith('games')) return;
    const params = new URLSearchParams();
    Object.entries(gamesFilters).forEach(([k, v]) => {
      const def = DEFAULT_GAMES_FILTERS[k];
      if (v && v !== def) params.set(k, v);
    });
    if (gamesPage > 0) params.set('page', String(gamesPage + 1));
    const qs = params.toString();
    const target = qs ? `/games?${qs}` : '/games';
    if (`${window.location.pathname}${window.location.search}` !== target) {
      window.history.replaceState({ view: 'games' }, '', target);
    }
  }

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

    syncUrlFromFilters();

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
    lastLoadedGames = data;
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
        <span class="opening-pill badge badge-outline badge-sm">${esc(g.opening_eco) || '?'}</span>
        ${truncate(g.opening_name, 28)}
      </td>
      <td data-label="Mistakes">
        <span class="${mistakeCountClass(g.mistake_count)}">
          ${g.mistake_count}
        </span>
      </td>
      <td data-label="Status">${analysisStatusMarkup(g.analyzed)}</td>
      <td data-label="Action"><button class="btn btn-ghost btn-sm min-h-[44px] whitespace-nowrap px-[10px] text-xs" type="button" data-open-game-id="${g.id}">Review</button></td>
    </tr>
  `
      )
      .join('');
  }

  function applyFilters() {
    syncFiltersFromControls();
    gamesPage = 0;
    loadGames();
    updateFiltersToggleLabel();
  }

  // Count filters that diverge from the resting defaults. Used to label the
  // collapsed toggle button so the user can see "Filters · 3 active" without
  // expanding the panel.
  function countActiveFilters() {
    let n = 0;
    for (const [k, def] of Object.entries(DEFAULT_GAMES_FILTERS)) {
      const cur = gamesFilters[k];
      if (cur === undefined || cur === null) continue;
      if (String(cur).trim() === String(def ?? '').trim()) continue;
      n += 1;
    }
    return n;
  }

  function setFiltersPanelVisible(visible) {
    const panel = dom.byId('games-filter-panel');
    const toggle = dom.byId('btn-toggle-games-filters');
    if (!panel) return;
    panel.hidden = !visible;
    toggle?.setAttribute('aria-expanded', String(!!visible));
  }

  function updateFiltersToggleLabel() {
    const countEl = dom.byId('games-filters-active-count');
    if (!countEl) return;
    const n = countActiveFilters();
    countEl.textContent = n ? `· ${n} active` : '';
  }

  function readFilterSlots() {
    try {
      const raw = localStorage.getItem(FILTER_SLOT_KEY);
      const parsed = raw ? JSON.parse(raw) : {};
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
      return {};
    }
  }

  function writeFilterSlots(slots) {
    localStorage.setItem(FILTER_SLOT_KEY, JSON.stringify(slots || {}));
  }

  function saveFilterSlot(slotName) {
    syncFiltersFromControls();
    const slots = readFilterSlots();
    slots[slotName] = { ...gamesFilters, savedAt: Date.now() };
    writeFilterSlots(slots);
    toast(`Saved filters to ${slotName.toUpperCase()}`);
  }

  function loadFilterSlot(slotName) {
    const slots = readFilterSlots();
    const slot = slots[slotName];
    if (!slot) {
      toast(`No saved filters in ${slotName.toUpperCase()}`);
      return;
    }
    gamesFilters = {
      ...DEFAULT_GAMES_FILTERS,
      ...slot,
    };
    delete gamesFilters.savedAt;
    writeFiltersToControls();
    activeGamesPreset = '';
    updatePresetUI();
    gamesPage = 0;
    loadGames();
    toast(`Loaded filters from ${slotName.toUpperCase()}`);
  }

  function exportCurrentPageCsv() {
    if (!lastLoadedGames.length) {
      toast('No games to export');
      return;
    }
    const rows = [
      ['date', 'color', 'result', 'opponent_rating', 'opening_eco', 'opening_name', 'mistakes', 'analyzed'],
      ...lastLoadedGames.map((g) => [
        g.date || '',
        g.color || '',
        g.result || '',
        g.opponent_rating || '',
        g.opening_eco || '',
        g.opening_name || '',
        g.mistake_count ?? 0,
        g.analyzed ?? 0,
      ]),
    ];
    const csv = rows
      .map((row) =>
        row
          .map((v) => `"${String(v ?? '').replace(/"/g, '""')}"`)
          .join(',')
      )
      .join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `games_page_${gamesPage + 1}_${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    toast('CSV exported');
  }

  async function copyQueueSummary() {
    const summary = [
      `Study Queue Summary`,
      `Filters: ${currentFilterSummary()}`,
      `Page: ${gamesPage + 1}`,
      `Total matches: ${totalGames}`,
      `Visible rows: ${lastLoadedGames.length}`,
    ].join('\n');
    try {
      await navigator.clipboard.writeText(summary);
      toast('Queue summary copied');
    } catch {
      toast('Copy failed');
    }
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
    const fromUrl = readFiltersFromUrl();
    if (fromUrl) {
      gamesFilters = fromUrl;
      writeFiltersToControls();
      const params = new URLSearchParams(window.location.search);
      const pageParam = parseInt(params.get('page') || '1', 10);
      gamesPage = Number.isFinite(pageParam) && pageParam > 0 ? pageParam - 1 : 0;
    }
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
    dom.byId('btn-save-filter-slot-1')?.addEventListener('click', () => saveFilterSlot('s1'));
    dom.byId('btn-load-filter-slot-1')?.addEventListener('click', () => loadFilterSlot('s1'));
    dom.byId('btn-save-filter-slot-2')?.addEventListener('click', () => saveFilterSlot('s2'));
    dom.byId('btn-load-filter-slot-2')?.addEventListener('click', () => loadFilterSlot('s2'));
    dom.byId('btn-save-filter-slot-3')?.addEventListener('click', () => saveFilterSlot('s3'));
    dom.byId('btn-load-filter-slot-3')?.addEventListener('click', () => loadFilterSlot('s3'));
    dom.byId('btn-export-games-csv')?.addEventListener('click', exportCurrentPageCsv);
    dom.byId('btn-copy-games-summary')?.addEventListener('click', copyQueueSummary);
    dom.byId('btn-toggle-games-filters')?.addEventListener('click', () => {
      const panel = dom.byId('games-filter-panel');
      setFiltersPanelVisible(!!panel?.hidden);
    });
    updateFiltersToggleLabel();
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
