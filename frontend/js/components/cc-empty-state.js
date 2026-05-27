// Lit primitive: empty / loading / error state panel.
//
// Replaces the inline `emptyStateMarkup` / `errorStateMarkup` / `loadingStateMarkup`
// helpers from ui.js. Same visual contract, same DOM output, but now with
// declarative props that map cleanly to a future React Native counterpart.
//
// Light DOM is intentional: existing Tailwind/daisyUI classes (.empty,
// .alert, .badge, etc.) live on the document, not in shadow scope, and
// screen-reader tooling reads light DOM more reliably.
//
// Usage:
//   <cc-empty-state title="No coach conversation yet" icon="♟"></cc-empty-state>
//   <cc-empty-state kind="error" title="Failed to load" body="Retry in a moment."></cc-empty-state>
//   <cc-empty-state kind="loading" title="Generating…"></cc-empty-state>
//   <cc-empty-state title="Add a line" cta-label="Add" cta-event="add-line"></cc-empty-state>
//
// CTAs: when cta-label is set, dispatches a CustomEvent named cta-event
// (default: "cta") on click. Bubbles + composed so listeners on the host
// view see it.

import { LitElement, html, nothing } from 'https://cdn.jsdelivr.net/npm/lit@3/+esm';

const ICON_BY_KIND = {
  empty: '♟',
  loading: null,
  error: '⚠',
};

export class CCEmptyState extends LitElement {
  // Light DOM: utility classes from the global stylesheet apply, and
  // existing audit tooling can find these without crossing a shadow boundary.
  createRenderRoot() {
    return this;
  }

  static properties = {
    kind: { type: String, reflect: true },
    title: { type: String },
    body: { type: String },
    icon: { type: String },
    compact: { type: Boolean, reflect: true },
    ctaLabel: { type: String, attribute: 'cta-label' },
    ctaEvent: { type: String, attribute: 'cta-event' },
  };

  constructor() {
    super();
    this.kind = 'empty';
    this.title = '';
    this.body = '';
    this.icon = '';
    this.compact = false;
    this.ctaLabel = '';
    this.ctaEvent = 'cta';
  }

  _onCta() {
    this.dispatchEvent(new CustomEvent(this.ctaEvent, { bubbles: true, composed: true }));
  }

  render() {
    const kind = this.kind === 'error' ? 'error' : this.kind === 'loading' ? 'loading' : 'empty';
    const role = kind === 'error' ? 'alert' : 'status';
    const alertClass = kind === 'error' ? 'alert-error' : 'alert-neutral';
    const padClass = this.compact ? 'empty-compact py-2' : 'py-3';
    const borderClass =
      kind === 'error'
        ? 'border border-[rgba(239,68,68,0.35)]'
        : 'border border-[var(--border)] bg-[var(--surface-2)] text-[var(--text)]';
    const icon = this.icon || ICON_BY_KIND[kind];

    return html`
      <div
        class="empty ${kind === 'error' ? 'empty-error' : ''} alert ${alertClass} ${borderClass} ${padClass}"
        role=${role}
        aria-live=${kind === 'loading' ? 'polite' : nothing}
      >
        ${kind === 'loading'
          ? html`<span class="loading loading-spinner loading-sm" aria-hidden="true"></span>`
          : icon
          ? html`<div class="empty-icon text-base leading-none">${icon}</div>`
          : nothing}
        <div class="cc-empty-text">
          ${this.title ? html`<span class="cc-empty-title">${this.title}</span>` : nothing}
          ${this.body
            ? html`<div class="cc-empty-body mt-1 text-xs text-[var(--muted)]">${this.body}</div>`
            : nothing}
        </div>
        ${this.ctaLabel
          ? html`<button
              class="btn btn-ghost btn-sm ml-auto"
              type="button"
              @click=${this._onCta}
            >
              ${this.ctaLabel}
            </button>`
          : nothing}
      </div>
    `;
  }
}

if (!customElements.get('cc-empty-state')) {
  customElements.define('cc-empty-state', CCEmptyState);
}
