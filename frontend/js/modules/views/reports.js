import { createDomCache } from '../dom.js';
import { endpoints } from '../contracts.js';
import { esc, fmt, statePanelMarkup, loadingStateMarkup, errorStateMarkup } from '../ui.js';

function renderMarkdown(md) {
  if (!md) return '';
  const safe = esc(md);
  const lines = safe.split('\n');
  const out = [];
  let inList = false;
  const closeList = () => {
    if (inList) {
      out.push('</ul>');
      inList = false;
    }
  };

  for (const raw of lines) {
    const line = raw.trimEnd();
    if (!line.trim()) {
      closeList();
      continue;
    }
    const h2 = line.match(/^##\s+(.*)$/);
    if (h2) {
      closeList();
      out.push(`<h4 class="report-h2 mt-4 mb-1 text-base font-semibold text-[var(--text)]">${h2[1]}</h4>`);
      continue;
    }
    const h3 = line.match(/^###\s+(.*)$/);
    if (h3) {
      closeList();
      out.push(`<h5 class="report-h3 mt-3 mb-1 text-sm font-semibold text-[var(--muted)]">${h3[1]}</h5>`);
      continue;
    }
    const bullet = line.match(/^\s*[-*]\s+(.*)$/);
    if (bullet) {
      if (!inList) {
        out.push('<ul class="report-list ml-5 list-disc text-sm leading-relaxed text-[var(--text)]">');
        inList = true;
      }
      out.push(`<li>${bullet[1]}</li>`);
      continue;
    }
    closeList();
    out.push(`<p class="report-p mt-2 text-sm leading-relaxed text-[var(--text)]">${line}</p>`);
  }
  closeList();
  return out.join('\n');
}

function fmtTimestamp(secs) {
  if (!secs) return '—';
  const d = new Date(Number(secs) * 1000);
  return isNaN(d.getTime()) ? '—' : d.toLocaleString();
}

export function createReportsView({ api, apiPost, toast }) {
  const dom = createDomCache();
  let polling = false;
  let pollAttempts = 0;

  function setStatus(msg, kind = 'info') {
    const el = dom.byId('reports-status');
    if (!el) return;
    if (!msg) {
      el.textContent = '';
      el.removeAttribute('data-kind');
      return;
    }
    el.textContent = msg;
    el.dataset.kind = kind;
  }

  function renderEmpty() {
    dom.byId('reports-latest-title').textContent = 'No report yet';
    dom.byId('reports-latest-meta').textContent = '';
    dom.byId('reports-latest-body').innerHTML = statePanelMarkup(
      'Generate your first weekly report. It uses your last 7 days of analysis.',
      { kind: 'empty', icon: '📋', compact: false }
    );
    dom.byId('reports-previous-title').textContent = '—';
    dom.byId('reports-previous-meta').textContent = '';
    dom.byId('reports-previous-body').innerHTML = statePanelMarkup(
      'Last week’s report will appear here once you have at least two weeks on file.',
      { kind: 'empty', icon: '🗓', compact: false }
    );
    dom.byId('reports-history').innerHTML = '';
  }

  function renderReport({ titleEl, metaEl, bodyEl, report, fallbackTitle }) {
    if (!titleEl) return;
    if (!report) {
      titleEl.textContent = fallbackTitle;
      metaEl.textContent = '';
      bodyEl.innerHTML = statePanelMarkup('No report available.', { kind: 'empty', icon: '📋', compact: false });
      return;
    }
    titleEl.textContent = `Week of ${fmt(report.date)}`;
    metaEl.textContent = `Generated ${fmtTimestamp(report.generated_at)} · ${Math.round((report.size_bytes || 0) / 10) / 100} KB`;
    bodyEl.innerHTML = renderMarkdown(report.markdown || '');
  }

  function renderHistory(items = []) {
    const list = dom.byId('reports-history');
    if (!list) return;
    if (!items.length) {
      list.innerHTML = '';
      return;
    }
    list.innerHTML = items
      .map(
        (item) => `
        <li>
          <button
            type="button"
            class="report-history-item btn btn-ghost w-full justify-between rounded-cc border border-[var(--border)] bg-[var(--surface-2)] px-3 py-2 text-left text-sm"
            data-report-date="${esc(item.date)}"
          >
            <span class="font-medium text-[var(--text)]">Week of ${fmt(item.date)}</span>
            <span class="text-xs text-[var(--muted)]">${fmtTimestamp(item.generated_at)}</span>
          </button>
        </li>
      `
      )
      .join('');
  }

  async function load() {
    const latestTitle = dom.byId('reports-latest-title');
    const latestMeta = dom.byId('reports-latest-meta');
    const latestBody = dom.byId('reports-latest-body');
    const previousTitle = dom.byId('reports-previous-title');
    const previousMeta = dom.byId('reports-previous-meta');
    const previousBody = dom.byId('reports-previous-body');

    if (!latestBody) return;

    latestBody.innerHTML = loadingStateMarkup('Loading latest report…', false);
    previousBody.innerHTML = loadingStateMarkup('Loading previous report…', false);

    try {
      const data = await api(endpoints.reportsLatest());
      const history = Array.isArray(data?.history) ? data.history : [];
      if (!data?.latest) {
        renderEmpty();
        return;
      }
      renderReport({
        titleEl: latestTitle,
        metaEl: latestMeta,
        bodyEl: latestBody,
        report: data.latest,
        fallbackTitle: 'No report yet',
      });
      renderReport({
        titleEl: previousTitle,
        metaEl: previousMeta,
        bodyEl: previousBody,
        report: data.previous,
        fallbackTitle: 'No previous report',
      });
      renderHistory(history);
    } catch (e) {
      latestBody.innerHTML = errorStateMarkup(`Failed to load report: ${e.message}`);
      previousBody.innerHTML = '';
    }
  }

  async function generate() {
    if (polling) return;
    polling = true;
    pollAttempts = 0;
    setStatus('Queued. Generating a fresh report — this can take 30–90 seconds depending on your hardware.', 'progress');
    dom.byId('reports-generate').disabled = true;
    try {
      await apiPost(endpoints.reportsGenerate(), {});
    } catch (e) {
      setStatus('');
      dom.byId('reports-generate').disabled = false;
      polling = false;
      toast('Report generation failed: ' + e.message);
      return;
    }
    pollLatest();
  }

  async function pollLatest() {
    if (!polling) return;
    pollAttempts += 1;
    if (pollAttempts > 60) {
      setStatus('Generation is taking longer than expected. Try Refresh in a minute.', 'warning');
      polling = false;
      dom.byId('reports-generate').disabled = false;
      return;
    }
    try {
      const data = await api(endpoints.reportsLatest());
      const today = new Date().toISOString().slice(0, 10);
      if (data?.latest?.date === today) {
        await load();
        setStatus('New report ready.', 'success');
        polling = false;
        dom.byId('reports-generate').disabled = false;
        return;
      }
    } catch (_) {
      // swallow; retry
    }
    setTimeout(pollLatest, 3000);
  }

  async function showHistorical(d) {
    const latestTitle = dom.byId('reports-latest-title');
    const latestMeta = dom.byId('reports-latest-meta');
    const latestBody = dom.byId('reports-latest-body');
    if (!latestBody) return;
    latestBody.innerHTML = loadingStateMarkup('Loading report…', false);
    try {
      const r = await api(endpoints.reportByDate(d));
      renderReport({
        titleEl: latestTitle,
        metaEl: latestMeta,
        bodyEl: latestBody,
        report: r,
        fallbackTitle: 'Report',
      });
      setStatus(`Showing report from ${d}.`, 'info');
    } catch (e) {
      latestBody.innerHTML = errorStateMarkup(`Could not load report: ${e.message}`);
    }
  }

  function bindEvents() {
    dom.byId('reports-generate')?.addEventListener('click', generate);
    dom.byId('reports-refresh')?.addEventListener('click', () => load());
    dom.byId('reports-history')?.addEventListener('click', (event) => {
      const btn = event.target.closest('[data-report-date]');
      if (!btn) return;
      showHistorical(btn.dataset.reportDate);
    });
  }

  return {
    bindEvents,
    load,
    generate,
  };
}
