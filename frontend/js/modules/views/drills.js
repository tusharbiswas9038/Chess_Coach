import {
  applyMove,
  fenTurn,
  parseFen,
  parseUCI,
  pickPromotion,
  renderPositionBoard,
  requiresPromotion,
} from '../board.js';
import { esc, setBadgeCount } from '../ui.js';
import { createDomCache } from '../dom.js';
import { endpoints, normalize } from '../contracts.js';
import { waitForJobByPrefix } from '../jobs.js';
import {
  enqueueDrillResult,
  flushDrillResults,
  isTransientNetworkError,
} from '../offline-queue.js';

export function createDrillsView({ api, apiContract, apiPost, toast }) {
  const dom = createDomCache();
  let drillQueue = [];
  let drillIdx = 0;
  let drillFlipped = false;
  let selectedSq = null;
  let boardPosition = {};
  let currentTurn = 'w';
  let correctUCI = null;
  let answered = false;
  let hintShown = false;
  let sessionDone = 0;
  let sessionCorrect = 0;
  let sessionWrong = 0;
  let sessionCorrectStreak = 0;
  let lastFrom = null;
  let lastTo = null;
  let loaded = false;
  let drillSummary = null;
  let puzzleSummary = null;
  let queueMode = 'adaptive';
  let motifFilter = '';
  let sessionMotifs = new Map();
  let puzzleJobPolling = false;

  function updateDrillBadge() {
    setBadgeCount(dom.byId('drill-badge'), drillSummary?.due_total ?? drillQueue.length);
  }

  async function refreshDrillSummary() {
    drillSummary = await apiContract(endpoints.drillsSummary(), normalize.drillsSummary, 'drillsSummary');
    updateDrillBadge();
    document.dispatchEvent(new CustomEvent('drills:progress-updated', { detail: drillSummary }));
    return drillSummary;
  }

  function renderPuzzleSummary() {
    const totalEl = dom.byId('drill-puzzle-total');
    const breakdownEl = dom.byId('drill-puzzle-breakdown');
    const chipsEl = dom.byId('drill-motif-chips');
    const motifSelect = dom.byId('drill-motif-filter');
    if (!puzzleSummary) return;

    if (totalEl) totalEl.textContent = Number(puzzleSummary.total || 0).toLocaleString();
    const difficulty = puzzleSummary.difficulty || {};
    if (breakdownEl) {
      breakdownEl.textContent =
        puzzleSummary.total > 0
          ? `Easy ${difficulty.easy || 0} · Medium ${difficulty.medium || 0} · Hard ${difficulty.hard || 0}`
          : 'No generated puzzles yet. Click Generate Puzzles.';
    }
    if (motifSelect) {
      const current = motifSelect.value;
      motifSelect.innerHTML = '<option value="">All motifs</option>' +
        (puzzleSummary.motifs || [])
          .map((m) => `<option value="${esc(m.motif)}">${esc(String(m.motif || '').replaceAll('_', ' '))} (${Number(m.count || 0)})</option>`)
          .join('');
      motifSelect.value = current;
    }
    if (chipsEl) {
      chipsEl.innerHTML = (puzzleSummary.motifs || [])
        .slice(0, 6)
        .map((m) => `<button class="badge badge-sm badge-outline min-h-[32px] cursor-pointer" type="button" data-drill-motif="${esc(m.motif)}">${esc(String(m.motif || '').replaceAll('_', ' '))}</button>`)
        .join('');
    }
  }

  function setPuzzleStatus(message, kind = '') {
    const status = dom.byId('drill-puzzle-status');
    if (!status) return;
    status.textContent = message;
    status.classList.toggle('text-[var(--primary)]', kind === 'success');
    status.classList.toggle('text-[var(--error)]', kind === 'error');
    status.classList.toggle('text-[var(--warning)]', kind === 'running');
  }

  async function refreshPuzzleSummary() {
    puzzleSummary = await apiContract(
      endpoints.drillsPuzzleSummary(),
      normalize.drillsPuzzleSummary,
      'drillsPuzzleSummary'
    );
    renderPuzzleSummary();
    return puzzleSummary;
  }

  function renderBoard() {
    renderPositionBoard('drill-board', boardPosition, {
      flipped: drillFlipped,
      selectedSquare: selectedSq,
      lastFrom,
      lastTo,
      hintSquare: hintShown ? parseUCI(correctUCI).from : null,
      onSquareClick: handleSquareClick,
      onMove: handleDragMove,
      isDraggable: (_sq, piece) => !answered && piece[0] === currentTurn,
    });
  }

  function handleDragMove(from, to) {
    if (answered) return;
    selectedSq = null;
    submitMove(from, to);
  }

  // Briefly flash the destination square green after a correct answer. The
  // pulse class is removed after the animation so a subsequent correct on
  // the same square retriggers it cleanly.
  function pulseDestinationSquare(sq) {
    const cell = document.querySelector(`#drill-board .sq[data-sq="${sq}"]`);
    if (!cell) return;
    cell.classList.remove('drill-correct-pulse');
    // Re-add on next frame so removal + addition register as a fresh animation.
    requestAnimationFrame(() => cell.classList.add('drill-correct-pulse'));
    setTimeout(() => cell.classList.remove('drill-correct-pulse'), 360);
  }

  // Apply a brief scale animation to the streak number whenever it changes.
  // Listening on `drill-progress-text` because that element is rebuilt every
  // render, so we toggle a class on whichever node is currently in the DOM.
  function bumpStreakNumber() {
    const el = dom.byId('drill-progress-text');
    if (!el) return;
    el.classList.remove('streak-bump');
    requestAnimationFrame(() => el.classList.add('streak-bump'));
    setTimeout(() => el.classList.remove('streak-bump'), 360);
  }

  async function submitMove(from, to) {
    const piece = boardPosition[from];
    let uci = from + to;
    if (piece && requiresPromotion(piece, from, to)) {
      const promo = await pickPromotion(currentTurn);
      uci = from + to + promo;
    }
    checkAnswer(from, to, uci);
  }

  function handleSquareClick(sq) {
    if (answered) return;

    const piece = boardPosition[sq];

    if (!selectedSq) {
      if (!piece || piece[0] !== currentTurn) return;
      selectedSq = sq;
      renderBoard();
      return;
    }

    if (selectedSq === sq) {
      selectedSq = null;
      renderBoard();
      return;
    }

    if (piece && piece[0] === currentTurn) {
      selectedSq = sq;
      renderBoard();
      return;
    }

    const attemptedUCI = selectedSq + sq;
    const from = selectedSq;
    selectedSq = null;
    submitMove(from, sq);
  }

  function checkAnswer(from, to, uci) {
    answered = true;
    const correct = parseUCI(correctUCI);
    const isCorrect = from === correct.from && to === correct.to;
    const previousStreak = sessionCorrectStreak;

    lastFrom = from;
    lastTo = to;

    const fb = dom.byId('drill-feedback');

    if (isCorrect) {
      boardPosition = applyMove(boardPosition, correctUCI, currentTurn);
      lastFrom = correct.from;
      lastTo = correct.to;
      renderBoard();
      fb.className = 'drill-feedback correct';
      const streakNote = sessionCorrectStreak >= 3 ? ` Hot streak: ${sessionCorrectStreak}.` : '';
      fb.textContent =
        'Correct. ' + correctUCI.toUpperCase() + ' was the best move.' + streakNote;
      sessionCorrect++;
      sessionCorrectStreak += 1;
      pulseDestinationSquare(correct.to);
    } else {
      renderBoard();
      fb.className = 'drill-feedback wrong';
      const acc = sessionDone > 0 ? Math.round((sessionCorrect / sessionDone) * 100) : 0;
      const breakNote = previousStreak >= 5
        ? ` (Streak of ${previousStreak} broken — back to building.)`
        : '';
      fb.textContent = `Not the best. You played ${uci.toUpperCase()}, but ${correctUCI.toUpperCase()} was correct. Accuracy ${acc}%. Slow down and check forcing moves.${breakNote}`;
      sessionWrong++;
      sessionCorrectStreak = 0;
      setTimeout(() => {
        boardPosition = applyMove(boardPosition, correctUCI, currentTurn);
        lastFrom = correct.from;
        lastTo = correct.to;
        renderBoard();
      }, 800);
    }

    const item = drillQueue[drillIdx];
    const motif = item?.motif || item?.mistake_type || item?.theme || 'mixed';
    const motifStats = sessionMotifs.get(motif) || { total: 0, wrong: 0 };
    motifStats.total += 1;
    if (!isCorrect) motifStats.wrong += 1;
    sessionMotifs.set(motif, motifStats);

    sessionDone++;
    updateSessionStats();
    if (isCorrect) bumpStreakNumber();
    dom.byId('quality-section').hidden = false;
    dom.byId('drill-hint-card').hidden = true;
    updateQueueList();
  }

  function showHint() {
    if (answered) return;
    hintShown = true;
    const { from } = parseUCI(correctUCI);
    const cell = dom.query(`[data-sq="${from}"]`);
    if (cell) cell.classList.add('hint');
    const fb = dom.byId('drill-feedback');
    fb.className = 'drill-feedback info';
    fb.textContent = `Hint: move the piece on ${from.toUpperCase()}`;
  }

  async function submitQuality(q) {
    const item = drillQueue[drillIdx];
    if (!item) return;

    const payload = { item_id: item.id, quality: q };
    const endpoint = endpoints.drillsResult();
    const localResult = { 0: 'fail', 1: 'hard', 2: 'good', 3: 'easy' }[q];

    try {
      const result = await apiPost(endpoint, payload);
      item.completed_today = 1;
      item.last_result = localResult || item.last_result;
      if (result?.summary) {
        drillSummary = normalize.drillsSummary(result.summary);
        updateDrillBadge();
        document.dispatchEvent(new CustomEvent('drills:progress-updated', { detail: drillSummary }));
      } else {
        await refreshDrillSummary();
      }
      // Opportunistic flush — if any earlier offline submits are queued,
      // a successful online call is a good moment to drain them.
      flushDrillResults(apiPost).then((r) => {
        if (r.flushed > 0) toast?.(`Synced ${r.flushed} offline drill${r.flushed === 1 ? '' : 's'}.`);
      });
    } catch (e) {
      if (isTransientNetworkError(e)) {
        // Network is down or unreachable. Queue the payload locally and
        // tell the user — the online event handler in app.js will flush.
        const queuedId = await enqueueDrillResult(payload, endpoint);
        if (queuedId != null) {
          item.completed_today = 1;
          item.last_result = localResult || item.last_result;
          toast?.('Saved offline — will sync when reconnected.');
        } else {
          toast?.('Offline and storage is unavailable. Result lost.');
        }
      } else {
        console.error('Failed to submit drill result:', e);
      }
    }

    drillIdx++;
    loadDrillItem();
  }

  function topSessionWeakness() {
    let top = null;
    for (const [motif, stats] of sessionMotifs.entries()) {
      if (!top || stats.wrong > top.stats.wrong || (stats.wrong === top.stats.wrong && stats.total > top.stats.total)) {
        top = { motif, stats };
      }
    }
    return top;
  }

  function renderSessionSummary() {
    const panel = dom.byId('drill-session-summary');
    const copy = dom.byId('drill-session-summary-copy');
    if (!panel || !copy) return;
    if (!sessionDone) {
      panel.hidden = true;
      return;
    }
    const accuracy = Math.round((sessionCorrect / sessionDone) * 100);
    const top = topSessionWeakness();
    const assignment = top?.stats.wrong
      ? `Next assignment: retry ${top.motif.replaceAll('_', ' ')} positions before adding new games.`
      : 'Next assignment: keep adaptive mode and maintain the daily streak.';
    copy.textContent = `${sessionDone} solved · ${accuracy}% accuracy · ${assignment}`;
    panel.hidden = false;
  }

  function loadDrillItem() {
    const total = drillQueue.length;
    dom.byId('ds-due').textContent = total;
    const totalDueEl = dom.byId('ds-total-due');
    if (totalDueEl) totalDueEl.textContent = drillSummary?.due_total ?? total;
    dom.byId('drill-counter').textContent = `${Math.min(
      drillIdx + 1,
      total
    )} / ${total}`;

    if (drillIdx >= total) {
      dom.byId('drill-board').innerHTML = '';
      dom.byId('drill-feedback').className = 'drill-feedback';
      dom.byId('quality-section').hidden = true;
      dom.byId('drill-hint-card').hidden = true;
      dom.byId('drill-empty').hidden = false;
      dom.byId('drill-turn-label').textContent =
        'Session complete!';
      updateSessionStats();
      renderSessionSummary();
      return;
    }

    dom.byId('drill-empty').hidden = true;
    dom.byId('drill-session-summary')?.setAttribute('hidden', '');

    const item = drillQueue[drillIdx];
    answered = false;
    hintShown = false;
    selectedSq = null;
    lastFrom = null;
    lastTo = null;
    correctUCI = item.correct_move;

    boardPosition = parseFen(item.fen);
    currentTurn = fenTurn(item.fen);

    const turnLabel = currentTurn === 'w' ? 'White to move' : 'Black to move';
    dom.byId(
      'drill-turn-label'
    ).textContent = `${turnLabel} — Find the best move`;

    const fb = dom.byId('drill-feedback');
    fb.className = 'drill-feedback';
    dom.byId('quality-section').hidden = true;

    const hintCard = dom.byId('drill-hint-card');
    hintCard.hidden = false;
    dom.byId('drill-theme-label').textContent = item.theme
      ? `Theme: ${item.theme.replaceAll('_', ' ')} · ${item.phase || 'phase ?'} · ${item.difficulty || 'medium'}`
      : 'Type: ' + (item.mistake_type || 'mistake');

    renderBoard();
    updateQueueList();
    updateSessionStats();
  }

  function updateQueueList() {
    const list = dom.byId('drill-queue-list');
    const show = drillQueue.slice(drillIdx, drillIdx + 8);
    if (show.length === 0) {
      list.innerHTML = '';
      return;
    }
    list.innerHTML = show
      .map(
        (item, i) => `
    <div class="drill-queue-item ${i === 0 ? 'current' : ''}">
      <span class="queue-order">${drillIdx + i + 1}.</span>
      <span class="mtag badge badge-xs queue-tag mtag-${
  item.mistake_type || 'blunder'
}">
        ${(item.motif || item.mistake_type || 'blunder').replaceAll('_', ' ')}
      </span>
      <span class="queue-date">
        ${esc(item.difficulty || item.due_date) || ''}
      </span>
    </div>
  `
      )
      .join('');
  }

  function updateSessionStats() {
    dom.byId('ds-done').textContent = sessionDone;
    dom.byId('ds-correct').textContent = sessionCorrect;
    dom.byId('ds-wrong').textContent = sessionWrong;

    const total = drillQueue.length;
    const pct = total > 0 ? (sessionDone / total) * 100 : 0;
    dom.byId('session-progress-bar').value = pct;
    dom.byId('drill-progress-text').textContent =
      sessionDone > 0
        ? `${sessionDone} done · ${sessionCorrect} correct · accuracy: ${Math.round(
          (sessionCorrect / sessionDone) * 100
        )}% · streak: ${sessionCorrectStreak}`
        : '';
  }

  function restoreSessionProgress(queue) {
    sessionDone = queue.filter((item) => Number(item.completed_today) === 1).length;
    sessionCorrect = queue.filter((item) => ['good', 'easy'].includes(item.last_result)).length;
    sessionWrong = queue.filter((item) => ['fail', 'hard'].includes(item.last_result)).length;
    sessionCorrectStreak = 0;
    sessionMotifs = new Map();
    const nextIndex = queue.findIndex((item) => Number(item.completed_today) !== 1);
    drillIdx = nextIndex >= 0 ? nextIndex : queue.length;
  }

  async function loadDrills(refreshQueue = false) {
    loaded = true;
    selectedSq = null;
    queueMode = dom.byId('drill-queue-mode')?.value || queueMode;
    motifFilter = dom.byId('drill-motif-filter')?.value?.trim() || '';

    try {
      const [queue, summary] = await Promise.all([
        apiContract(endpoints.drillsDue(15, refreshQueue, queueMode, motifFilter), normalize.drillsDue, 'drillsDue'),
        refreshDrillSummary(),
        refreshPuzzleSummary(),
      ]);
      drillQueue = queue;
      drillSummary = summary;
      restoreSessionProgress(queue);
    } catch (e) {
      toast('Failed to load drills: ' + e.message);
      return;
    }

    updateDrillBadge();
    const focus = dom.byId('drill-session-focus');
    if (focus) {
      focus.textContent =
        queueMode === 'retry'
          ? 'Retry mode: clear recent hard/failed motifs before starting new material.'
          : queueMode === 'motif' && motifFilter
            ? `Motif mode: focus only on ${motifFilter.replaceAll('_', ' ')} positions.`
            : 'Adaptive mode: current weakness and recent failure motifs are prioritized first.';
    }
    loadDrillItem();
  }

  function flipBoard() {
    drillFlipped = !drillFlipped;
    renderBoard();
  }

  function ensureLoaded() {
    if (!loaded) {
      loadDrills();
      return;
    }
    if (drillIdx < drillQueue.length) renderBoard();
  }

  function bindEvents() {
    dom.byId('btn-reload-drills').addEventListener('click', () => loadDrills(true));
    dom.byId('btn-generate-puzzles')?.addEventListener('click', async () => {
      if (puzzleJobPolling) return;
      const btn = dom.byId('btn-generate-puzzles');
      try {
        puzzleJobPolling = true;
        if (btn) {
          btn.disabled = true;
          btn.textContent = 'Generating…';
        }
        const startedAtSec = Date.now() / 1000;
        setPuzzleStatus('Puzzle generation queued…', 'running');
        await apiPost(endpoints.drillsGeneratePuzzles(), {});
        toast('Puzzle generation queued.');
        setPuzzleStatus('Generating puzzles from your mistakes…', 'running');
        const result = await waitForJobByPrefix(api, 'puzzles', {
          startedAtSec,
          timeoutMs: 180000,
          pollMs: 2000,
        });
        if (result.ok) {
          await refreshPuzzleSummary();
          setPuzzleStatus('Puzzle generation completed. Puzzle bank updated.', 'success');
          toast('Puzzle generation completed.');
          return;
        }
        if (result.timeout) {
          setPuzzleStatus('Puzzle generation is still running in the background.', 'running');
          toast('Puzzle generation still running.');
          return;
        }
        setPuzzleStatus(`Puzzle generation failed: ${result.job?.error || 'unknown error'}`, 'error');
        toast('Puzzle generation failed.');
      } catch (e) {
        setPuzzleStatus('Puzzle generation failed.', 'error');
        toast('Puzzle generation failed: ' + e.message);
      } finally {
        puzzleJobPolling = false;
        if (btn) {
          btn.disabled = false;
          btn.textContent = 'Generate Puzzles';
        }
      }
    });
    dom.byId('drill-queue-mode')?.addEventListener('change', () => loadDrills(true));
    dom.byId('drill-motif-filter')?.addEventListener('change', () => {
      if (dom.byId('drill-queue-mode')?.value === 'motif') loadDrills(true);
    });
    dom.byId('drill-motif-chips')?.addEventListener('click', (event) => {
      const btn = event.target.closest('[data-drill-motif]');
      if (!btn) return;
      const mode = dom.byId('drill-queue-mode');
      const motif = dom.byId('drill-motif-filter');
      if (mode) mode.value = 'motif';
      if (motif) motif.value = btn.dataset.drillMotif || '';
      loadDrills(true);
    });
    document.addEventListener('data:games-updated', () => {
      refreshPuzzleSummary().catch(() => {});
    });
    dom.query('.flip-btn').addEventListener('click', flipBoard);
    dom.byId('quality-section')?.addEventListener('click', (event) => {
      const btn = event.target.closest('.quality-btn[data-q]');
      if (!btn) return;
      submitQuality(parseInt(btn.dataset.q, 10));
    });
    dom.byId('btn-show-hint').addEventListener('click', showHint);
  }

  return {
    bindEvents,
    ensureLoaded,
    loadDrills,
  };
}
