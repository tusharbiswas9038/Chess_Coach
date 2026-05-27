// review-whatif.js
//
// Self-contained what-if controller for the review board. Owns the small
// state machine (request id, current arrow, click-to-move selection),
// the inline status renderer, and the click/drag handlers.
//
// Lives separately from review.js so the review module stays focused on
// move navigation and analysis rendering, not engine-roundtrip flow.

import { parseFen, pickPromotion, requiresPromotion } from '../board.js';

function formatCp(cp) {
  if (cp == null) return '—';
  if (cp >= 9000) return '#';
  if (cp <= -9000) return '−#';
  const sign = cp > 0 ? '+' : '';
  return `${sign}${(cp / 100).toFixed(2)}`;
}

function deltaText(delta) {
  if (delta == null) return '—';
  return `${delta > 0 ? '+' : ''}${(delta / 100).toFixed(2)}`;
}

function deltaTone(delta) {
  if (delta == null) return 'info';
  if (delta < -50) return 'warn';
  if (delta > 50) return 'good';
  return 'info';
}

export function createWhatIfController({
  apiPost,
  endpoint,
  dom,
  requestRender,
  depthSelectId = 'review-whatif-depth',
  statusElId = 'review-whatif-status',
  defaultDepth = 14,
}) {
  let requestId = 0;
  let arrow = null;            // { fen, from, to }
  let selectedSq = null;
  let selectedFen = null;

  function statusEl() {
    return dom.byId(statusElId);
  }

  function clearStatus() {
    const el = statusEl();
    if (el) {
      el.textContent = '';
      el.removeAttribute('data-kind');
    }
  }

  function setStatus(text, kind = 'info') {
    const el = statusEl();
    if (!el) return;
    el.textContent = text;
    el.dataset.kind = kind;
  }

  function getDepth() {
    const select = dom.byId(depthSelectId);
    return select ? parseInt(select.value, 10) || defaultDepth : defaultDepth;
  }

  function arrowFor(fen) {
    return arrow && arrow.fen === fen
      ? { from: arrow.from, to: arrow.to, tone: 'best' }
      : null;
  }

  function selectionFor(fen) {
    return selectedSq && selectedFen === fen ? selectedSq : null;
  }

  // Called by the view after each renderReviewBoard. If the position has
  // changed (different fen), drop stale arrow + selection so they don't
  // visually leak.
  function syncTo(fen) {
    if (!arrow || arrow.fen !== fen) {
      arrow = null;
      clearStatus();
    }
    if (selectedFen !== fen) {
      selectedSq = null;
      selectedFen = null;
    }
  }

  async function run(fen, from, to, turn) {
    const piece = parseFen(fen)[from];
    let move = from + to;
    if (piece && requiresPromotion(piece, from, to)) {
      const promo = await pickPromotion(turn || (piece && piece[0]) || 'w');
      move = from + to + promo;
    }
    const myId = ++requestId;
    const depth = getDepth();
    setStatus(`Evaluating ${move.toUpperCase()} at depth ${depth}…`, 'progress');
    try {
      const result = await apiPost(endpoint, { fen, move, depth });
      if (myId !== requestId) return;
      const cachedNote = result.cached ? ' · cached' : '';
      const bestNote = result.best_move ? ` · best ${result.best_move.toUpperCase()}` : '';
      setStatus(
        `${move.toUpperCase()}: ${formatCp(result.eval_before)} → ${formatCp(result.eval_after)} (Δ ${deltaText(result.delta)})${bestNote}${cachedNote}`,
        deltaTone(result.delta)
      );
      // Surface the engine's preferred move as an arrow when it differs
      // from what the user tried. Same-as-played gets no arrow.
      if (result.best_move && result.best_move.toLowerCase() !== move.toLowerCase()) {
        arrow = {
          fen,
          from: result.best_move.slice(0, 2),
          to: result.best_move.slice(2, 4),
        };
        if (typeof requestRender === 'function') requestRender();
      }
    } catch (e) {
      if (myId !== requestId) return;
      setStatus(`What-if failed: ${e.message}`, 'error');
    }
  }

  // Click-to-move flow that mirrors the drills board: first click selects
  // a piece of the side-to-move; second click runs what-if; clicking the
  // same square deselects.
  function handleSquareClick(sq, position, fen, turn) {
    const piece = position[sq];

    if (!selectedSq) {
      if (!piece || piece[0] !== turn) return;
      selectedSq = sq;
      selectedFen = fen;
      if (typeof requestRender === 'function') requestRender();
      return;
    }

    if (selectedSq === sq) {
      selectedSq = null;
      selectedFen = null;
      if (typeof requestRender === 'function') requestRender();
      return;
    }

    if (piece && piece[0] === turn) {
      selectedSq = sq;
      selectedFen = fen;
      if (typeof requestRender === 'function') requestRender();
      return;
    }

    const from = selectedSq;
    selectedSq = null;
    selectedFen = null;
    run(fen, from, sq, turn);
  }

  return {
    run,
    handleSquareClick,
    arrowFor,
    selectionFor,
    syncTo,
    clearStatus,
  };
}
