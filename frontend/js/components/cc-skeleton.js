// Lit primitive: skeleton loader for various content shapes.
//
// Replaces the inline `<div class="skeleton h-3 w-[42%] ...">` patterns
// scattered across views. Variants encode the content shape (kpi card,
// chart, table row, motif row, etc.) so callers don't have to remember
// the exact dimensions for each.
//
// Usage:
//   <cc-skeleton variant="kpi"></cc-skeleton>
//   <cc-skeleton variant="row"></cc-skeleton>
//   <cc-skeleton variant="chart"></cc-skeleton>
//   <cc-skeleton variant="text" lines="3"></cc-skeleton>

import { LitElement, html, nothing } from 'https://cdn.jsdelivr.net/npm/lit@3/+esm';

export class CCSkeleton extends LitElement {
  // Light DOM keeps the existing daisyUI .skeleton animation reachable.
  createRenderRoot() {
    return this;
  }

  static properties = {
    variant: { type: String, reflect: true },
    lines: { type: Number },
  };

  constructor() {
    super();
    this.variant = 'row';
    this.lines = 1;
  }

  _kpi() {
    return html`
      <div class="kpi-card p-4">
        <div class="skeleton h-3 w-[42%] mb-[10px] rounded-cc"></div>
        <div class="skeleton h-[30px] w-[56%] mb-[10px] rounded-cc"></div>
        <div class="skeleton h-3 w-[74%] rounded-cc"></div>
      </div>
    `;
  }

  _chart() {
    return html`
      <div class="chart-card p-4">
        <div class="skeleton h-4 w-[40%] mb-3 rounded-cc"></div>
        <div class="skeleton h-[160px] w-full rounded-cc"></div>
      </div>
    `;
  }

  _row() {
    return html`<div class="skeleton h-4 w-full rounded-cc"></div>`;
  }

  _motif() {
    return html`
      <div class="motif-row rounded-cc border border-[var(--border)] bg-[var(--surface-2)] p-3">
        <div class="flex items-start justify-between gap-3">
          <div class="min-w-0 grow">
            <div class="skeleton h-3.5 w-[72%] mb-2 rounded-cc"></div>
            <div class="skeleton h-3 w-[48%] rounded-cc"></div>
          </div>
          <div class="skeleton h-9 w-[80px] rounded-cc"></div>
        </div>
      </div>
    `;
  }

  _text() {
    const lines = Math.max(1, Math.min(Number(this.lines) || 1, 8));
    return html`
      <div class="grid gap-2">
        ${Array.from({ length: lines }).map(
          (_, i) => html`<div class="skeleton h-3 rounded-cc cc-skel-text-line" data-line="${i % 8}"></div>`
        )}
      </div>
    `;
  }

  render() {
    switch (this.variant) {
      case 'kpi':
        return this._kpi();
      case 'chart':
        return this._chart();
      case 'motif':
        return this._motif();
      case 'text':
        return this._text();
      case 'row':
      default:
        return this._row();
    }
  }
}

if (!customElements.get('cc-skeleton')) {
  customElements.define('cc-skeleton', CCSkeleton);
}
