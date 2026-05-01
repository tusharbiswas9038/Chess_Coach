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
  return `<span class="badge ${map[r] || ''}">${safe.toUpperCase()}</span>`;
}

export function colorBadge(c) {
  const safe = esc(c);
  return `<span class="badge badge-${safe}">${
    safe.charAt(0).toUpperCase() + safe.slice(1)
  }</span>`;
}

export function mistakeTag(type) {
  if (!type) return '<span class="mtag">—</span>';
  const labels = {
    blunder: '⚡ Blunder',
    hanging_piece: '⚠️ Hanging',
    mistake: '△ Mistake',
  };
  return `<span class="mtag mtag-${esc(type)}">${
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
  if (count > 10) return 'mistake-count mistake-count-high';
  if (count > 5) return 'mistake-count mistake-count-medium';
  return 'mistake-count mistake-count-low';
}

export function analysisStatusMarkup(status) {
  if (status === 1) {
    return '<span class="status-text status-done">✓ analyzed</span>';
  }
  if (status === 2) {
    return '<span class="status-text status-error">✗ error</span>';
  }
  return '<span class="status-text status-pending">⏳ pending</span>';
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
  return `<div class="empty${compact ? ' empty-compact' : ''}"><div class="empty-icon">${icon}</div>${esc(message)}</div>`;
}

export function errorStateMarkup(message) {
  return `<div class="empty">${esc(message)}</div>`;
}
