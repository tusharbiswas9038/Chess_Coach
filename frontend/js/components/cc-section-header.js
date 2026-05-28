// Lit primitive: section header.
//
// Standardizes the kicker + title + subtitle pattern that opens nearly every
// view (workspace-hero, hero-banner, card-header). Today the markup is
// duplicated 8+ times; replacing it with a single component makes the
// visual treatment a one-place change.
//
// Light DOM means slots can't redistribute children, so this component is
// intentionally text-only. When a section needs an action button alongside
// the header, wrap both in a flex container at the call site:
//
//   <header class="card-header flex items-start justify-between gap-3
//                  border-b border-[var(--border)] px-4 py-3 max-sm:flex-col">
//     <cc-section-header variant="card"
//       kicker="Insights / Weekly"
//       title="Weekly coaching report"
//       subtitle="Generated from your last 7 days of analysis."
//     ></cc-section-header>
//     <button class="btn btn-primary">Generate</button>
//   </header>
//
// Variants control the visual weight:
//   variant="hero"      — large workspace hero (default).
//   variant="card"      — card-header style.
//   variant="compact"   — small section opener inside an existing card.

import { LitElement, html, nothing } from 'https://cdn.jsdelivr.net/npm/lit@3/+esm';

export class CCSectionHeader extends LitElement {
  // Light DOM so all existing kicker/title/subtitle classes apply.
  createRenderRoot() {
    return this;
  }

  static properties = {
    kicker: { type: String },
    title: { type: String },
    subtitle: { type: String },
    variant: { type: String, reflect: true },
  };

  constructor() {
    super();
    this.kicker = '';
    this.title = '';
    this.subtitle = '';
    this.variant = 'hero';
  }

  _titleClass() {
    if (this.variant === 'card') return 'card-title';
    if (this.variant === 'compact') return 'text-base font-semibold text-[var(--text)]';
    return 'workspace-hero-title section-title mt-1 text-[var(--text)]';
  }

  _subtitleClass() {
    if (this.variant === 'card') return 'card-subtitle';
    if (this.variant === 'compact') return 'mt-1 text-xs text-[var(--muted)]';
    return 'workspace-hero-summary mt-2 max-w-[58ch] text-[var(--muted)]';
  }

  render() {
    return html`
      <div class="min-w-0">
        ${this.kicker
          ? html`<div class="section-kicker">${this.kicker}</div>`
          : nothing}
        ${this.title
          ? html`<h2 class="${this._titleClass()}">${this.title}</h2>`
          : nothing}
        ${this.subtitle
          ? html`<p class="${this._subtitleClass()}">${this.subtitle}</p>`
          : nothing}
      </div>
    `;
  }
}

if (!customElements.get('cc-section-header')) {
  customElements.define('cc-section-header', CCSectionHeader);
}
