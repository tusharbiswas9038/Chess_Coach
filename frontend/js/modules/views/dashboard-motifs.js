// dashboard-motifs.js
//
// Renders the "Recurring mistake motifs" panel on the dashboard. Owns the
// motif list markup and the click handler that opens a game from a motif's
// example. Kept separate from dashboard.js so dashboard stays focused on
// session orchestration and KPIs.

import { esc, statePanelMarkup } from '../ui.js';

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
    const subtype = String(m.subtype || 'mistake').replace(/_/g, ' ');
    const phase = m.phase || 'unknown';
    const family = m.opening_family && m.opening_family !== '?'
      ? `ECO ${m.opening_family}`
      : 'mixed openings';
    const occurrences = Number(m.occurrences || 0);
    const avg = Number(m.avg_eval_loss || 0);
    const latest = m.latest_date ? String(m.latest_date).slice(0, 10) : '-';
    const exampleId = m.example_game_id;
    const exampleBtn = exampleId
      ? `<button class="btn btn-ghost btn-sm" type="button" data-open-game-id="${esc(exampleId)}">Open example</button>`
      : '';
    const coachLabel = (m.coach_label || '').trim();
    const labelLine = coachLabel
      ? `<div class="text-sm text-[var(--text)] mb-1">${esc(coachLabel)}</div>`
      : '';
    return `
      <li class="motif-row rounded-cc border border-[var(--border)] bg-[var(--surface-2)] p-3">
        <div class="flex items-start justify-between gap-3 max-sm:flex-col">
          <div class="min-w-0">
            ${labelLine}
            <div class="text-sm font-semibold text-[var(--text)]">
              ${esc(subtype)} <span class="text-[var(--muted)]">in</span> ${esc(phase)}
            </div>
            <div class="mt-1 text-xs text-[var(--muted)]">
              ${esc(family)} &middot; last seen ${esc(latest)}
            </div>
          </div>
          <div class="flex shrink-0 items-center gap-3 text-right">
            <div>
              <div class="text-lg font-bold text-[var(--text)]">${occurrences}x</div>
              <div class="text-xs text-[var(--muted)]">avg ${avg.toFixed(0)}cp lost</div>
            </div>
            ${exampleBtn}
          </div>
        </div>
      </li>
    `;
  }

  function bindEvents() {
    dom.byId(LIST_ID)?.addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-open-game-id]');
      if (btn && typeof onOpenGame === 'function') {
        onOpenGame(btn.dataset.openGameId);
      }
    });
  }

  return {
    render,
    bindEvents,
  };
}
