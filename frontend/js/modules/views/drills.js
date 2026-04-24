import {
  applyMove,
  fenTurn,
  parseFen,
  parseUCI,
  renderPositionBoard,
} from '../board.js';
import { esc, setBadgeCount } from '../ui.js';

export function createDrillsView({ api, apiPost, toast }) {
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
  let lastFrom = null;
  let lastTo = null;
  let loaded = false;

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

    const fb = document.getElementById('drill-feedback');

    if (isCorrect) {
      boardPosition = applyMove(boardPosition, correctUCI, currentTurn);
      lastFrom = correct.from;
      lastTo = correct.to;
      renderBoard();
      fb.className = 'drill-feedback correct';
      fb.textContent =
        '✓ Correct! ' + correctUCI.toUpperCase() + ' was the best move.';
      sessionCorrect++;
    } else {
      renderBoard();
      fb.className = 'drill-feedback wrong';
      fb.textContent = `✗ Not the best. You played ${uci.toUpperCase()}, but ${correctUCI.toUpperCase()} was correct.`;
      sessionWrong++;
      setTimeout(() => {
        boardPosition = applyMove(boardPosition, correctUCI, currentTurn);
        lastFrom = correct.from;
        lastTo = correct.to;
        renderBoard();
      }, 800);
    }

    sessionDone++;
    updateSessionStats();
    document.getElementById('quality-section').hidden = false;
    document.getElementById('drill-hint-card').hidden = true;
    updateQueueList();
  }

  function showHint() {
    if (answered) return;
    hintShown = true;
    const { from } = parseUCI(correctUCI);
    const cell = document.querySelector(`[data-sq="${from}"]`);
    if (cell) cell.classList.add('hint');
    const fb = document.getElementById('drill-feedback');
    fb.className = 'drill-feedback info';
    fb.textContent = `Hint: move the piece on ${from.toUpperCase()}`;
  }

  async function submitQuality(q) {
    const item = drillQueue[drillIdx];
    if (!item) return;

    try {
      await apiPost('/api/drills/result', { item_id: item.id, quality: q });
    } catch (e) {
      console.error('Failed to submit drill result:', e);
    }

    drillIdx++;
    loadDrillItem();
  }

  function loadDrillItem() {
    const total = drillQueue.length;
    document.getElementById('ds-due').textContent = total;
    document.getElementById('drill-counter').textContent = `${Math.min(
      drillIdx + 1,
      total
    )} / ${total}`;

    if (drillIdx >= total) {
      document.getElementById('drill-board').innerHTML = '';
      document.getElementById('drill-feedback').className = 'drill-feedback';
      document.getElementById('quality-section').hidden = true;
      document.getElementById('drill-hint-card').hidden = true;
      document.getElementById('drill-empty').hidden = false;
      document.getElementById('drill-turn-label').textContent =
        'Session complete!';
      updateSessionStats();
      return;
    }

    document.getElementById('drill-empty').hidden = true;

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
    document.getElementById(
      'drill-turn-label'
    ).textContent = `${turnLabel} — Find the best move`;

    const fb = document.getElementById('drill-feedback');
    fb.className = 'drill-feedback';
    document.getElementById('quality-section').hidden = true;

    const hintCard = document.getElementById('drill-hint-card');
    hintCard.hidden = false;
    document.getElementById('drill-theme-label').textContent = item.theme
      ? `Theme: ${item.theme.replace('_', ' ')}`
      : 'Type: ' + (item.mistake_type || 'mistake');

    renderBoard();
    updateQueueList();
    updateSessionStats();
  }

  function updateQueueList() {
    const list = document.getElementById('drill-queue-list');
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
      <span class="mtag queue-tag mtag-${
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
    document.getElementById('ds-done').textContent = sessionDone;
    document.getElementById('ds-correct').textContent = sessionCorrect;
    document.getElementById('ds-wrong').textContent = sessionWrong;

    const total = drillQueue.length;
    const pct = total > 0 ? (sessionDone / total) * 100 : 0;
    document.getElementById('session-progress-bar').value = pct;
    document.getElementById('drill-progress-text').textContent =
      sessionDone > 0
        ? `${sessionDone} done · ${sessionCorrect} correct · accuracy: ${Math.round(
          (sessionCorrect / sessionDone) * 100
        )}%`
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
      drillQueue = await api('/api/drills/due?limit=15');
    } catch (e) {
      toast('Failed to load drills: ' + e.message);
      return;
    }

    setBadgeCount(document.getElementById('drill-badge'), drillQueue.length);
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
    document.getElementById('btn-reload-drills').addEventListener('click', loadDrills);
    document.querySelector('.flip-btn').addEventListener('click', flipBoard);
    document.querySelectorAll('.quality-btn').forEach((btn) => {
      btn.addEventListener('click', () => submitQuality(parseInt(btn.dataset.q)));
    });
    document.getElementById('btn-show-hint').addEventListener('click', showHint);
  }

  return {
    bindEvents,
    ensureLoaded,
    loadDrills,
  };
}
