// Lit primitive: KPI card.
//
// Replaces the 4-block markup pattern repeated ~7× in dashboard.js and 3×
// in mistakes.js (icon + label + value + sub). The component owns the
// markup; the view passes data and tone, and the design system owns the
// visual treatment via the existing .kpi-card / .kpi-label / .kpi-value /
// .kpi-sub classes.
//
// Tone mapping is duplicated from formatStat severity so the component can
// be used without going through formatStat (e.g. KPI cards that aren't a
// known metric, like "Drill Goal" or "Streak / Achievement"). When you do
// have a formatStat result, pass severity directly:
//
//   <cc-kpi-card kicker icon="!" label="Hanging Rate" value="81%"
//                sub="piece-safety leak" severity="bad"></cc-kpi-card>
//
// Or pass an explicit tone:
//
//   <cc-kpi-card icon="↗" label="Win Rate" value="58%" tone="good"
//                sub="this week"></cc-kpi-card>
//
// `severity` wins when both are given.

import { LitElement, html, nothing } from 'https://cdn.jsdelivr.net/npm/lit@3/+esm';

const SEVERITY_TO_TONE = {
  good: 'good',
  warn: 'warn',
  bad: 'bad',
  neutral: '',
  unknown: '',
};

const TONE_CLASS = {
  good: 'kpi-good',
  warn: 'kpi-warn',
  bad: 'kpi-bad',
  blue: 'kpi-blue',
};

const ICON_TONE_VAR = {
  good: 'var(--primary)',
  warn: 'var(--warning)',
  bad: 'var(--error)',
  blue: 'var(--blue)',
  analytics: 'var(--analytics)',
};

export class CCKpiCard extends LitElement {
  // Light DOM so utility classes from tailwind.css apply.
  createRenderRoot() {
    return this;
  }

  static properties = {
    label: { type: String },
    value: { type: String },
    sub: { type: String },
    icon: { type: String },
    tone: { type: String, reflect: true },
    severity: { type: String, reflect: true },
    iconTone: { type: String, attribute: 'icon-tone' },
  };

  constructor() {
    super();
    this.label = '';
    this.value = '—';
    this.sub = '';
    this.icon = '';
    this.tone = '';
    this.severity = '';
    this.iconTone = '';
  }

  _resolveTone() {
    if (this.tone) return this.tone;
    if (this.severity) return SEVERITY_TO_TONE[this.severity] || '';
    return '';
  }

  _iconColor() {
    const which = this.iconTone || this._resolveTone() || 'analytics';
    return ICON_TONE_VAR[which] || ICON_TONE_VAR.analytics;
  }

  render() {
    const valueClass = TONE_CLASS[this._resolveTone()] || '';
    return html`
      <div class="kpi-card p-4">
        ${this.icon
          ? html`<div class="mb-2 text-lg" style="color: ${this._iconColor()}">${this.icon}</div>`
          : nothing}
        <div class="kpi-label text-xs font-medium uppercase tracking-wide text-[var(--muted)]">
          ${this.label}
        </div>
        <div class="kpi-value ${valueClass} mt-2 text-2xl font-semibold">${this.value}</div>
        ${this.sub
          ? html`<div class="kpi-sub mt-1 text-xs text-[var(--muted)]">${this.sub}</div>`
          : nothing}
      </div>
    `;
  }
}

if (!customElements.get('cc-kpi-card')) {
  customElements.define('cc-kpi-card', CCKpiCard);
}
