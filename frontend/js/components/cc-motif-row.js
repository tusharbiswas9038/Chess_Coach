// Lit primitive: mistake-motif row.
//
// Renders one entry of the "Recurring mistake motifs" panel on the dashboard.
// Today the row markup is built as a template literal inside dashboard-motifs.js
// (~30 lines per motif). Promoting it to a component lets the dashboard map
// over an array of `<cc-motif-row>` elements and lets a future RN port consume
// the same prop shape directly.
//
// Props are flat scalars — same shape as the API payload from
// /api/product/motifs/latest. Click events on the example button bubble up
// as `open-game` with the game id in detail.

import { LitElement, html, nothing } from 'https://cdn.jsdelivr.net/npm/lit@3/+esm';

export class CCMotifRow extends LitElement {
  // Light DOM so the existing .motif-row / .btn-ghost styles apply and so
  // event delegation up to the dashboard list still works.
  createRenderRoot() {
    return this;
  }

  static properties = {
    subtype: { type: String },
    phase: { type: String },
    family: { type: String },
    occurrences: { type: Number },
    avgEvalLoss: { type: Number, attribute: 'avg-eval-loss' },
    latestDate: { type: String, attribute: 'latest-date' },
    coachLabel: { type: String, attribute: 'coach-label' },
    exampleGameId: { type: String, attribute: 'example-game-id' },
  };

  constructor() {
    super();
    this.subtype = 'mistake';
    this.phase = 'unknown';
    this.family = '';
    this.occurrences = 0;
    this.avgEvalLoss = 0;
    this.latestDate = '';
    this.coachLabel = '';
    this.exampleGameId = '';
  }

  _onOpenExample() {
    if (!this.exampleGameId) return;
    this.dispatchEvent(
      new CustomEvent('open-game', {
        detail: { gameId: this.exampleGameId },
        bubbles: true,
        composed: true,
      })
    );
  }

  render() {
    const subtype = String(this.subtype || 'mistake').replace(/_/g, ' ');
    const phase = this.phase || 'unknown';
    const familyText =
      this.family && this.family !== '?' ? `ECO ${this.family}` : 'mixed openings';
    const occ = Number(this.occurrences || 0);
    const avg = Number(this.avgEvalLoss || 0);
    const latest = this.latestDate ? String(this.latestDate).slice(0, 10) : '-';
    const label = (this.coachLabel || '').trim();

    return html`
      <li class="motif-row rounded-cc border border-[var(--border)] bg-[var(--surface-2)] p-3">
        <div class="flex items-start justify-between gap-3 max-sm:flex-col">
          <div class="min-w-0">
            ${label
              ? html`<div class="text-sm text-[var(--text)] mb-1">${label}</div>`
              : nothing}
            <div class="text-sm font-semibold text-[var(--text)]">
              ${subtype} <span class="text-[var(--muted)]">in</span> ${phase}
            </div>
            <div class="mt-1 text-xs text-[var(--muted)]">
              ${familyText} &middot; last seen ${latest}
            </div>
          </div>
          <div class="flex shrink-0 items-center gap-3 text-right">
            <div>
              <div class="text-lg font-bold text-[var(--text)]">${occ}x</div>
              <div class="text-xs text-[var(--muted)]">avg ${avg.toFixed(0)}cp lost</div>
            </div>
            ${this.exampleGameId
              ? html`<button
                  class="btn btn-ghost btn-sm"
                  type="button"
                  @click=${this._onOpenExample}
                >
                  Open example
                </button>`
              : nothing}
          </div>
        </div>
      </li>
    `;
  }
}

if (!customElements.get('cc-motif-row')) {
  customElements.define('cc-motif-row', CCMotifRow);
}
