export function esc(s) {
  if (s == null) return '—';
  return String(s).replace(
    /[&<>"']/g,
    (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&#39;' }[
        c
      ])
  );
}

export function fmt(dateStr) {
  if (!dateStr) return '—';
  const d = new Date(dateStr);
  return isNaN(d.getTime())
    ? '—'
    : d.toLocaleDateString('en-IN', {
      day: '2-digit',
      month: 'short',
      year: '2-digit',
    });
}

export function resultBadge(r) {
  const safe = esc(r);
  const map = { win: 'badge-win', loss: 'badge-loss', draw: 'badge-draw' };
  return `<span class="badge badge-sm ${map[r] || ''}">${safe.toUpperCase()}</span>`;
}

export function colorBadge(c) {
  const safe = esc(c);
  return `<span class="badge badge-sm badge-${safe}">${
    safe.charAt(0).toUpperCase() + safe.slice(1)
  }</span>`;
}

export function mistakeTag(type) {
  if (!type) return '<span class="mtag badge badge-xs">—</span>';
  const labels = {
    blunder: 'Blunder',
    hanging_piece: 'Hanging Piece',
    mistake: 'Mistake',
  };
  return `<span class="mtag badge badge-xs mtag-${esc(type)}">${
    labels[type] || esc(type)
  }</span>`;
}

export function subtypeLabel(subtype) {
  const labels = {
    tactical_blunder: 'Tactical blunder',
    missed_tactic: 'Missed tactic',
    strategic_concession: 'Strategic concession',
    conversion_miss: 'Conversion miss',
    opening_inaccuracy: 'Opening inaccuracy',
  };
  return labels[subtype] || (subtype ? String(subtype).replaceAll('_', ' ') : '—');
}

export function subtypeChip(subtype) {
  if (!subtype) return '';
  return `<span class="badge badge-xs border border-[rgba(168,85,247,0.3)] bg-[rgba(168,85,247,0.12)] text-[var(--analytics)]">${esc(subtypeLabel(subtype))}</span>`;
}

export function truncate(str, n) {
  if (!str) return '—';
  const s = String(str);
  return esc(s.length > n ? s.slice(0, n) + '…' : s);
}

export function setBadgeCount(el, count) {
  if (!el) return;
  const safeCount = Number(count) || 0;
  if (safeCount > 0) {
    el.textContent = safeCount > 99 ? '99+' : String(safeCount);
    el.title = safeCount > 99 ? `${safeCount.toLocaleString()} due drills` : `${safeCount} due drill${safeCount === 1 ? '' : 's'}`;
    el.hidden = false;
    return;
  }
  el.textContent = '';
  el.removeAttribute('title');
  el.hidden = true;
}

export function mistakeCountClass(count) {
  if (count > 10) return 'font-semibold text-[var(--error)]';
  if (count > 5) return 'font-semibold text-[var(--warning)]';
  return 'font-semibold text-[var(--primary)]';
}

export function analysisStatusMarkup(status) {
  if (status === 1) {
    return '<span class="text-xs text-[var(--primary)]">Analyzed</span>';
  }
  if (status === 2) {
    return '<span class="text-xs text-[var(--error)]">Error</span>';
  }
  return '<span class="text-xs text-[var(--muted)]">Pending</span>';
}

export function evalDeltaClass(delta) {
  if (delta == null) return 'cell-strong cell-muted';
  if (delta < -200) return 'cell-strong text-error';
  if (delta < -100) return 'cell-strong text-warning';
  return 'cell-strong cell-muted';
}

export function openingToneClass(winPct) {
  if (winPct >= 50) return 'progress-fill-good';
  if (winPct >= 35) return 'progress-fill-warn';
  return 'progress-fill-bad';
}

export function openingToneTextClass(winPct) {
  if (winPct >= 50) return 'text-success';
  if (winPct >= 35) return 'text-warning';
  return 'text-error';
}

export function emptyStateMarkup(message, icon = '♟', compact = false) {
  return `
    <div class="empty alert alert-neutral border border-[var(--border)] bg-[var(--surface-2)] text-[var(--text)]${compact ? ' empty-compact py-2' : ' py-3'}" role="status">
      <div class="empty-icon text-base leading-none">${icon}</div>
      <span>${esc(message)}</span>
    </div>
  `;
}

export function errorStateMarkup(message) {
  return `
    <div class="empty empty-error alert alert-error border border-[rgba(239,68,68,0.35)]" role="alert">
      <div class="empty-icon text-base leading-none">⚠</div>
      <span>${esc(message)}</span>
    </div>
  `;
}

export function loadingStateMarkup(message = 'Loading…', compact = false) {
  return `
    <div class="empty alert alert-neutral border border-[var(--border)] bg-[var(--surface-2)] text-[var(--text)]${compact ? ' empty-compact py-2' : ' py-3'}" role="status" aria-live="polite">
      <span class="loading loading-spinner loading-sm" aria-hidden="true"></span>
      <span>${esc(message)}</span>
    </div>
  `;
}

export function statePanelMarkup(message, options = {}) {
  const {
    kind = 'empty',
    compact = true,
    icon = '♟',
    actions = '',
  } = options;
  const content =
    kind === 'loading'
      ? loadingStateMarkup(message, compact)
      : kind === 'error'
        ? errorStateMarkup(message)
        : emptyStateMarkup(message, icon, compact);
  const actionsMarkup = actions
    ? `<div class="mt-2 flex flex-wrap items-center gap-2">${actions}</div>`
    : '';
  return `${content}${actionsMarkup}`;
}

export function tableStateRowMarkup(message, colspan, options = {}) {
  const { kind = 'empty', icon = '♟', actions = '' } = options;
  const content = statePanelMarkup(message, { kind, icon, compact: true, actions });
  return `<tr><td class="p-0" colspan="${Number(colspan) || 1}">${content}</td></tr>`;
}

// formatStat — translate a raw metric value into a coaching-voice trio.
//
// Premium products pair numbers with interpretation. "81% · piece-safety risk"
// reads like a coach; "81%" reads like a database row. This helper keeps the
// translation table in one place so coach context, KPI subtitles, and the
// mistakes header all read consistently.
//
// Returns:
//   {
//     value: string,     // formatted display value, e.g. "81%" or "10.8"
//     label: string,     // short coach-voice tag, e.g. "piece-safety risk"
//     severity: "good" | "neutral" | "warn" | "bad" | "unknown",
//   }
//
// Unknown metrics return a passthrough { value: String(value), label: '', severity: 'unknown' }
// so call sites can fall back gracefully without a try/catch.
export function formatStat(metric, value) {
  if (value == null || Number.isNaN(Number(value))) {
    return { value: '—', label: '', severity: 'unknown' };
  }
  const n = Number(value);

  switch (metric) {
    case 'hanging_piece_rate': {
      // Stored as 0..1, capped at 1.0. Above 0.6 is unusually high for any
      // rating band — that's "fix this first" territory.
      const pct = `${Math.round(n * 100)}%`;
      if (n < 0.2) return { value: pct, label: 'piece-safety solid', severity: 'good' };
      if (n < 0.4) return { value: pct, label: 'piece-safety ok', severity: 'neutral' };
      if (n < 0.6) return { value: pct, label: 'piece-safety risk', severity: 'warn' };
      return { value: pct, label: 'piece-safety leak', severity: 'bad' };
    }

    case 'blunders_per_game': {
      const display = n.toFixed(1);
      if (n < 1) return { value: display, label: 'low blunder rate', severity: 'good' };
      if (n < 2) return { value: display, label: 'manageable blunder rate', severity: 'neutral' };
      if (n < 4) return { value: display, label: 'high blunder rate', severity: 'warn' };
      return { value: display, label: 'very high blunder rate', severity: 'bad' };
    }

    case 'win_rate': {
      // Accepts both 0..1 and 0..100; auto-detect.
      const ratio = n > 1 ? n / 100 : n;
      const pct = `${Math.round(ratio * 100)}%`;
      if (ratio >= 0.55) return { value: pct, label: 'winning more than losing', severity: 'good' };
      if (ratio >= 0.45) return { value: pct, label: 'roughly even', severity: 'neutral' };
      if (ratio >= 0.35) return { value: pct, label: 'losing more often', severity: 'warn' };
      return { value: pct, label: 'tough stretch', severity: 'bad' };
    }

    case 'mistakes_per_game': {
      const display = n.toFixed(1);
      if (n < 2) return { value: display, label: 'mostly clean games', severity: 'good' };
      if (n < 4) return { value: display, label: 'some inaccuracies', severity: 'neutral' };
      if (n < 7) return { value: display, label: 'frequent mistakes', severity: 'warn' };
      return { value: display, label: 'mistake-heavy games', severity: 'bad' };
    }

    case 'time_pressure_blunder_rate': {
      // 0..1: rate of mistakes/blunders on moves with <60s on the clock.
      const pct = `${Math.round(n * 100)}%`;
      if (n < 0.15) return { value: pct, label: 'calm under pressure', severity: 'good' };
      if (n < 0.3) return { value: pct, label: 'time pressure shows', severity: 'neutral' };
      if (n < 0.5) return { value: pct, label: 'crumbles under pressure', severity: 'warn' };
      return { value: pct, label: 'time-pressure leak', severity: 'bad' };
    }

    case 'drills_due': {
      const display = String(Math.round(n));
      if (n === 0) return { value: display, label: 'queue clear', severity: 'good' };
      if (n < 10) return { value: display, label: 'manageable queue', severity: 'neutral' };
      if (n < 25) return { value: display, label: 'queue building', severity: 'warn' };
      return { value: display, label: 'queue overflowing', severity: 'bad' };
    }

    case 'streak': {
      const display = String(Math.round(n));
      if (n >= 10) return { value: display, label: 'on fire', severity: 'good' };
      if (n >= 5) return { value: display, label: 'consistent', severity: 'good' };
      if (n >= 2) return { value: display, label: 'building', severity: 'neutral' };
      return { value: display, label: 'fresh start', severity: 'neutral' };
    }

    default:
      return { value: String(value), label: '', severity: 'unknown' };
  }
}

// Convenience: return the Tailwind tone class for a severity. Centralized so
// the same severity → color mapping applies wherever stats are rendered.
export function statSeverityToneClass(severity) {
  return {
    good: 'text-success',
    neutral: 'text-[var(--muted)]',
    warn: 'text-warning',
    bad: 'text-error',
    unknown: 'text-[var(--muted)]',
  }[severity] || 'text-[var(--muted)]';
}
