// Lit primitive: stat pill.
//
// Standardizes the small inline-pill compositions that used to ship as raw
// `<span class="active-pill">…</span>` / `<span class="quality-pill">…</span>`
// markup across review hero, dashboard hero, and the games table. The pill
// classes already lived in tailwind.input.css; this component just wraps the
// visual treatment behind a declarative prop surface so call sites read like
// data, not styling.
//
// Tone mapping (1:1 with the existing CSS classes in tailwind.input.css):
//   tone=""        → quality-pill   (default neutral pill)
//   tone="active"  → active-pill    (green-tinted, "you" / "active" affordance)
//   tone="quality" → quality-pill   (neutral metadata pill)
//   tone="eval"    → eval-pill      (engine eval / count tag, baseline tone)
//   tone="opening" → opening-pill   (boxy ECO badge, square corners)
//
// Render shape:
//   value=""  → "<label>"               // one-token tag
//   value!="" → "<label> · <value>"     // labelled stat
//
// Usage:
//   <cc-stat-pill tone="active" label="You" value="white"></cc-stat-pill>
//   <cc-stat-pill tone="quality" label="Opponent" value="1623"></cc-stat-pill>
//   <cc-stat-pill tone="opening" label="B20"></cc-stat-pill>
//   <cc-stat-pill tone="quality" label="middlegame"></cc-stat-pill>
//
// Light DOM is intentional — the rendered <span> picks up Tailwind/daisyUI
// utility classes from the page just like any other element, and assistive
// tech reads the pill's text without crossing a shadow boundary.

import { LitElement, html } from 'https://cdn.jsdelivr.net/npm/lit@3/+esm';

const TONE_CLASS = {
  active: 'active-pill',
  quality: 'quality-pill',
  eval: 'eval-pill',
  opening: 'opening-pill',
};

export class CCStatPill extends LitElement {
  // Light DOM so the existing pill classes apply unchanged.
  createRenderRoot() {
    return this;
  }

  static properties = {
    label: { type: String },
    value: { type: String },
    tone: { type: String, reflect: true },
  };

  constructor() {
    super();
    this.label = '';
    this.value = '';
    this.tone = '';
  }

  _toneClass() {
    return TONE_CLASS[this.tone] || TONE_CLASS.quality;
  }

  render() {
    const cls = this._toneClass();
    const text = this.value ? `${this.label} · ${this.value}` : this.label;
    return html`<span class="${cls}">${text}</span>`;
  }
}

if (!customElements.get('cc-stat-pill')) {
  customElements.define('cc-stat-pill', CCStatPill);
}
