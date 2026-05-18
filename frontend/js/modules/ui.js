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

export function truncate(str, n) {
  if (!str) return '—';
  const s = String(str);
  return esc(s.length > n ? s.slice(0, n) + '…' : s);
}

export function setBadgeCount(el, count) {
  if (!el) return;
  if (count > 0) {
    el.textContent = count;
    el.hidden = false;
    return;
  }
  el.textContent = '';
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
  return `${content}${actions || ''}`;
}

export function tableStateRowMarkup(message, colspan, options = {}) {
  const { kind = 'empty', icon = '♟', actions = '' } = options;
  const content = statePanelMarkup(message, { kind, icon, compact: true, actions });
  return `<tr><td class="p-0" colspan="${Number(colspan) || 1}">${content}</td></tr>`;
}
