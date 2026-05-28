// dashboard-motifs.js
//
// Renders the "Recurring mistake motifs" panel on the dashboard. Owns the
// motif list and the click handler that opens a game from a motif's
// example. The row markup itself lives in <cc-motif-row> — this module
// just maps the API payload onto component attributes and listens for the
// `open-game` event the component emits.

import { statePanelMarkup, esc } from '../ui.js';

export function createDashboardMotifsView({ dom, onOpenGame }) {
  const LIST_ID = 'dashboard-motifs-list';
  const META_ID = 'dashboard-motifs-meta';

  function render(payload) {
    const list = dom.byId(LIST_ID);
    const meta = dom.byId(META_ID);
    if (!list) return;

    const motifs = Array.isArray(payload?.motifs) ? payload.motifs : [];
    if (!motifs.length) {
      list.innerHTML = `<li>${statePanelMarkup(
        'No motifs yet — they appear after the next analyze job runs.',
        { kind: 'empty', icon: '#', compact: true }
      )}</li>`;
      if (meta) meta.textContent = '';
      return;
    }

    if (meta) meta.textContent = `${motifs.length} pattern${motifs.length === 1 ? '' : 's'}`;
    list.innerHTML = motifs.map(renderMotifRow).join('');
  }

  function renderMotifRow(m) {
    // <cc-motif-row> reads scalar attributes; we still escape any string
    // that lands in an attribute to keep injection out of the template
    // literal. Numeric attributes are converted directly.
    const subtype = String(m.subtype || 'mistake');
    const phase = String(m.phase || 'unknown');
    const family = String(m.opening_family || '');
    const latest = m.latest_date ? String(m.latest_date) : '';
    const coachLabel = (m.coach_label || '').trim();
    const exampleId = m.example_game_id || '';
    return `
      <cc-motif-row
        subtype="${esc(subtype)}"
        phase="${esc(phase)}"
        family="${esc(family)}"
        occurrences="${Number(m.occurrences || 0)}"
        avg-eval-loss="${Number(m.avg_eval_loss || 0)}"
        latest-date="${esc(latest)}"
        ${coachLabel ? `coach-label="${esc(coachLabel)}"` : ''}
        ${exampleId ? `example-game-id="${esc(exampleId)}"` : ''}
      ></cc-motif-row>
    `;
  }

  function bindEvents() {
    dom.byId(LIST_ID)?.addEventListener('open-game', (e) => {
      const gameId = e.detail?.gameId;
      if (gameId && typeof onOpenGame === 'function') {
        onOpenGame(gameId);
      }
    });
  }

  return {
    render,
    bindEvents,
  };
}
