import {
  applyMove,
  fenTurn,
  parseFen,
  parseUCI,
  renderPositionBoard,
} from '../board.js';
import { esc, setBadgeCount } from '../ui.js';
import { createDomCache } from '../dom.js';
import { endpoints, normalize } from '../contracts.js';

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

  function updateDrillBadge() {
    setBadgeCount(dom.byId('drill-badge'), drillSummary?.due_total ?? drillQueue.length);
  }

  async function refreshDrillSummary() {
    drillSummary = await apiContract(endpoints.drillsSummary(), normalize.drillsSummary, 'drillsSummary');
    updateDrillBadge();
    document.dispatchEvent(new CustomEvent('drills:progress-updated', { detail: drillSummary }));
    return drillSummary;
  }

  function renderBoard() {
    renderPositionBoard('drill-board', boardPosition, {
      flipped: drillFlipped,
      selectedSquare: selectedSq,
      lastFrom,
      lastTo,
      hintSquare: hintShown ? parseUCI(correctUCI).from : null,
      onSquareClick: handleSquareClick,
    });
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
    checkAnswer(from, sq, attemptedUCI);
  }

  function checkAnswer(from, to, uci) {
    answered = true;
    const correct = parseUCI(correctUCI);
    const isCorrect = from === correct.from && to === correct.to;

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
    } else {
      renderBoard();
      fb.className = 'drill-feedback wrong';
      const acc = sessionDone > 0 ? Math.round((sessionCorrect / sessionDone) * 100) : 0;
      fb.textContent = `Not the best. You played ${uci.toUpperCase()}, but ${correctUCI.toUpperCase()} was correct. Accuracy ${acc}%. Slow down and check forcing moves.`;
      sessionWrong++;
      sessionCorrectStreak = 0;
      setTimeout(() => {
        boardPosition = applyMove(boardPosition, correctUCI, currentTurn);
        lastFrom = correct.from;
        lastTo = correct.to;
        renderBoard();
      }, 800);
    }

    sessionDone++;
    updateSessionStats();
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

    try {
      const result = await apiPost(endpoints.drillsResult(), { item_id: item.id, quality: q });
      if (result?.summary) {
        drillSummary = normalize.drillsSummary(result.summary);
        updateDrillBadge();
        document.dispatchEvent(new CustomEvent('drills:progress-updated', { detail: drillSummary }));
      } else {
        await refreshDrillSummary();
      }
    } catch (e) {
      console.error('Failed to submit drill result:', e);
    }

    drillIdx++;
    loadDrillItem();
  }

  function loadDrillItem() {
    const total = drillQueue.length;
    dom.byId('ds-due').textContent = total;
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
      return;
    }

    dom.byId('drill-empty').hidden = true;

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
      ? `Theme: ${item.theme.replace('_', ' ')}`
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
        ${(item.mistake_type || 'blunder').replace('_', ' ')}
      </span>
      <span class="queue-date">
        ${esc(item.due_date) || ''}
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

  async function loadDrills() {
    loaded = true;
    drillIdx = 0;
    sessionDone = 0;
    sessionCorrect = 0;
    sessionWrong = 0;
    selectedSq = null;

    try {
      const [queue, summary] = await Promise.all([
        apiContract(endpoints.drillsDue(15), normalize.drillsDue, 'drillsDue'),
        refreshDrillSummary(),
      ]);
      drillQueue = queue;
      drillSummary = summary;
    } catch (e) {
      toast('Failed to load drills: ' + e.message);
      return;
    }

    updateDrillBadge();
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
    dom.byId('btn-reload-drills').addEventListener('click', loadDrills);
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
