const PIECES = {
  wP: '♙',
  wN: '♘',
  wB: '♗',
  wR: '♖',
  wQ: '♕',
  wK: '♔',
  bP: '♟',
  bN: '♞',
  bB: '♝',
  bR: '♜',
  bQ: '♛',
  bK: '♚',
};

export function parseFen(fen) {
  const pos = {};
  const rows = fen.split(' ')[0].split('/');
  const files = 'abcdefgh';
  rows.forEach((row, ri) => {
    let fi = 0;
    for (const ch of row) {
      if (/\d/.test(ch)) {
        fi += parseInt(ch);
        continue;
      }
      const rank = 8 - ri;
      const sq = files[fi] + rank;
      const color = ch === ch.toUpperCase() ? 'w' : 'b';
      const type = ch.toUpperCase();
      pos[sq] = color + type;
      fi++;
    }
  });
  return pos;
}

export function fenTurn(fen) {
  return fen.split(' ')[1] || 'w';
}

export function parseUCI(uci) {
  return { from: uci.slice(0, 2), to: uci.slice(2, 4), promo: uci[4] || null };
}

export function applyMove(pos, uci, turn) {
  const p = { ...pos };
  const { from, to, promo } = parseUCI(uci);
  const piece = p[from];
  if (!piece) return p;
  delete p[from];

  if (piece[1] === 'P' && from[0] !== to[0] && !p[to]) {
    const epRank = turn === 'w' ? parseInt(to[1]) - 1 : parseInt(to[1]) + 1;
    delete p[to[0] + epRank];
  }

  if (piece[1] === 'K') {
    if (from === 'e1' && to === 'g1') {
      delete p.h1;
      p.f1 = 'wR';
    }
    if (from === 'e1' && to === 'c1') {
      delete p.a1;
      p.d1 = 'wR';
    }
    if (from === 'e8' && to === 'g8') {
      delete p.h8;
      p.f8 = 'bR';
    }
    if (from === 'e8' && to === 'c8') {
      delete p.a8;
      p.d8 = 'bR';
    }
  }

  p[to] = promo ? turn + promo.toUpperCase() : piece;
  return p;
}

// Threshold (in pixels) past which a pointer-down + move counts as a drag
// rather than a click. Below this we let click-to-move take over.
const DRAG_THRESHOLD_PX = 6;

export function renderPositionBoard(
  boardId,
  position,
  {
    flipped = false,
    selectedSquare = null,
    lastFrom: fromSquare = null,
    lastTo: toSquare = null,
    hintSquare = null,
    onSquareClick = null,
    onMove = null,
    isDraggable = null,
  } = {}
) {
  const board = document.getElementById(boardId);
  if (!board) return;
  board.innerHTML = '';
  const grid = document.createElement('div');
  grid.className = 'board-grid';

  const files = 'abcdefgh';
  for (let r = 8; r >= 1; r--) {
    for (let fi = 0; fi < 8; fi++) {
      const f = flipped ? files[7 - fi] : files[fi];
      const rank = flipped ? 9 - r : r;
      const sq = f + rank;
      const isLight = (fi + r) % 2 === 0;

      const cell = document.createElement('div');
      cell.className = 'sq ' + (isLight ? 'light' : 'dark');
      cell.dataset.sq = sq;

      if (selectedSquare === sq) cell.classList.add('selected');
      if (fromSquare === sq) cell.classList.add('last-from');
      if (toSquare === sq) cell.classList.add('last-to');
      if (hintSquare === sq) cell.classList.add('hint');

      if (flipped ? rank === 8 : rank === 1) {
        const lbl = document.createElement('div');
        lbl.className = `sq-label-file ${isLight ? 'sq-label-on-light' : 'sq-label-on-dark'}`;
        lbl.textContent = f;
        cell.appendChild(lbl);
      }

      if (flipped ? f === 'h' : f === 'a') {
        const lbl = document.createElement('div');
        lbl.className = `sq-label-rank ${isLight ? 'sq-label-on-light' : 'sq-label-on-dark'}`;
        lbl.textContent = rank;
        cell.appendChild(lbl);
      }

      const piece = position[sq];
      if (piece && PIECES[piece]) {
        const pieceEl = document.createElement('div');
        pieceEl.className = `piece ${piece[0] === 'w' ? 'piece-white' : 'piece-black'}`;
        pieceEl.textContent = PIECES[piece];
        cell.appendChild(pieceEl);
      }

      if (onSquareClick) {
        cell.addEventListener('click', () => onSquareClick(sq));
      }
      grid.appendChild(cell);
    }
  }
  board.appendChild(grid);

  if (onMove) {
    attachDragAndDrop(board, grid, { position, onMove, isDraggable });
  }
}

function attachDragAndDrop(boardEl, gridEl, { position, onMove, isDraggable }) {
  // Pointer-event drag-and-drop. Falls back gracefully — pointerdown on a
  // square also fires click after pointerup if the pointer didn't move,
  // so click-to-move still works for users who prefer it.
  let active = null;

  function pieceAt(sq) {
    return position[sq] || null;
  }

  function isPieceDraggable(sq) {
    const piece = pieceAt(sq);
    if (!piece) return false;
    if (typeof isDraggable === 'function') return !!isDraggable(sq, piece);
    return true;
  }

  function squareFromPoint(x, y) {
    const el = document.elementFromPoint(x, y);
    if (!el) return null;
    const sqEl = el.closest?.('.sq');
    return sqEl?.dataset?.sq || null;
  }

  function onPointerDown(event) {
    if (event.button !== undefined && event.button !== 0) return;
    const cell = event.target.closest?.('.sq');
    if (!cell || !gridEl.contains(cell)) return;
    const sq = cell.dataset.sq;
    if (!sq || !isPieceDraggable(sq)) return;
    const pieceEl = cell.querySelector('.piece');
    if (!pieceEl) return;

    active = {
      from: sq,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      pieceEl,
      cell,
      dragging: false,
      lastTarget: null,
    };
    // Prevent the browser's native drag/select behaviour and scroll-on-touch.
    event.preventDefault();
    try {
      cell.setPointerCapture(event.pointerId);
    } catch (_) {
      // older browsers without pointer capture — drag still works via
      // window-level listeners below.
    }
  }

  function onPointerMove(event) {
    if (!active || event.pointerId !== active.pointerId) return;
    const dx = event.clientX - active.startX;
    const dy = event.clientY - active.startY;
    if (!active.dragging) {
      if (Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) return;
      active.dragging = true;
      active.pieceEl.classList.add('piece-dragging');
    }
    active.pieceEl.style.transform = `translate(${dx}px, ${dy}px)`;
    const target = squareFromPoint(event.clientX, event.clientY);
    if (target !== active.lastTarget) {
      if (active.lastTarget) {
        gridEl.querySelector(`.sq[data-sq="${active.lastTarget}"]`)?.classList.remove('drop-target');
      }
      if (target && target !== active.from) {
        gridEl.querySelector(`.sq[data-sq="${target}"]`)?.classList.add('drop-target');
      }
      active.lastTarget = target;
    }
  }

  function clearDrag() {
    if (!active) return;
    active.pieceEl.style.transform = '';
    active.pieceEl.classList.remove('piece-dragging');
    if (active.lastTarget) {
      gridEl.querySelector(`.sq[data-sq="${active.lastTarget}"]`)?.classList.remove('drop-target');
    }
    try {
      active.cell.releasePointerCapture?.(active.pointerId);
    } catch (_) {
      /* ignore */
    }
    active = null;
  }

  function onPointerUp(event) {
    if (!active || event.pointerId !== active.pointerId) return;
    const wasDragging = active.dragging;
    const from = active.from;
    const target = wasDragging ? squareFromPoint(event.clientX, event.clientY) : null;
    clearDrag();
    if (wasDragging && target && target !== from) {
      // Dragged onto a real square — fire the move and suppress the
      // synthetic click that would otherwise restart click-to-move state.
      event.preventDefault?.();
      event.stopPropagation?.();
      onMove(from, target);
    }
  }

  function onPointerCancel(event) {
    if (!active || event.pointerId !== active.pointerId) return;
    clearDrag();
  }

  // Bind on the grid for down/move/up so we don't leak window listeners.
  gridEl.addEventListener('pointerdown', onPointerDown);
  gridEl.addEventListener('pointermove', onPointerMove);
  gridEl.addEventListener('pointerup', onPointerUp);
  gridEl.addEventListener('pointercancel', onPointerCancel);
  gridEl.addEventListener('lostpointercapture', onPointerCancel);
}
