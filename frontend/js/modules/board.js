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

// Pawn promotion: returns true when the move would land a pawn on its
// promotion rank. The board widget doesn't validate move legality (the
// callers do), but we always need to know whether to ask for a piece.
export function requiresPromotion(piece, from, to) {
  if (!piece || piece[1] !== 'P') return false;
  if (piece[0] === 'w' && from?.[1] === '7' && to?.[1] === '8') return true;
  if (piece[0] === 'b' && from?.[1] === '2' && to?.[1] === '1') return true;
  return false;
}

// Show a small 4-piece picker (Q/R/B/N). Resolves to a UCI promo char
// ('q'|'r'|'b'|'n'). Esc / click-outside resolves to 'q' — sensible default
// for almost every real position. Anchored under the document body so the
// stacking context is independent of the board's scroll container.
export function pickPromotion(turn = 'w') {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'promotion-overlay';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-label', 'Choose promotion piece');

    const panel = document.createElement('div');
    panel.className = 'promotion-panel';
    const choices = [
      { key: 'q', label: turn === 'w' ? '♕' : '♛' },
      { key: 'r', label: turn === 'w' ? '♖' : '♜' },
      { key: 'b', label: turn === 'w' ? '♗' : '♝' },
      { key: 'n', label: turn === 'w' ? '♘' : '♞' },
    ];

    function close(value) {
      overlay.remove();
      window.removeEventListener('keydown', onKey);
      resolve(value);
    }
    function onKey(e) {
      if (e.key === 'Escape') {
        e.preventDefault();
        close('q');
      } else if (['q', 'r', 'b', 'n'].includes(e.key.toLowerCase())) {
        e.preventDefault();
        close(e.key.toLowerCase());
      }
    }

    choices.forEach((c) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = `promotion-choice promotion-choice-${turn}`;
      btn.dataset.promo = c.key;
      btn.setAttribute('aria-label', `Promote to ${c.key.toUpperCase()}`);
      btn.textContent = c.label;
      btn.addEventListener('click', () => close(c.key));
      panel.appendChild(btn);
    });

    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) close('q');
    });
    window.addEventListener('keydown', onKey);

    overlay.appendChild(panel);
    document.body.appendChild(overlay);
    panel.querySelector('.promotion-choice')?.focus();
  });
}

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
    arrow = null,
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

  if (arrow && arrow.from && arrow.to && arrow.from !== arrow.to) {
    grid.appendChild(buildArrowOverlay(arrow, flipped));
  }

  if (onMove) {
    attachDragAndDrop(board, grid, { position, onMove, isDraggable });
  }
}

// Draws an SVG arrow over the board grid pointing from `arrow.from` to
// `arrow.to` (algebraic squares). Uses a 100×100 viewBox so coordinates
// translate directly into percent of the grid; the SVG itself fills the
// grid via absolute positioning.
function buildArrowOverlay(arrow, flipped) {
  const files = 'abcdefgh';
  const tone = arrow.tone || 'best';

  function center(sq) {
    const file = files.indexOf(sq[0]);
    const rank = parseInt(sq[1], 10);
    if (file < 0 || !Number.isFinite(rank)) return null;
    // Each square is 12.5% of the grid; +6.25 lands at the center.
    const fileIndex = flipped ? 7 - file : file;
    const rankIndex = flipped ? rank - 1 : 8 - rank;
    return {
      x: fileIndex * 12.5 + 6.25,
      y: rankIndex * 12.5 + 6.25,
    };
  }

  const a = center(arrow.from);
  const b = center(arrow.to);
  const svgNS = 'http://www.w3.org/2000/svg';
  const wrap = document.createElement('div');
  wrap.className = `board-arrow board-arrow-${tone}`;
  wrap.setAttribute('aria-hidden', 'true');
  if (!a || !b) return wrap;

  const svg = document.createElementNS(svgNS, 'svg');
  svg.setAttribute('viewBox', '0 0 100 100');
  svg.setAttribute('preserveAspectRatio', 'none');
  svg.classList.add('board-arrow-svg');

  const arrowId = `board-arrow-head-${tone}`;
  const defs = document.createElementNS(svgNS, 'defs');
  const marker = document.createElementNS(svgNS, 'marker');
  marker.setAttribute('id', arrowId);
  marker.setAttribute('viewBox', '0 0 10 10');
  marker.setAttribute('refX', '7');
  marker.setAttribute('refY', '5');
  marker.setAttribute('markerWidth', '6');
  marker.setAttribute('markerHeight', '6');
  marker.setAttribute('orient', 'auto-start-reverse');
  const head = document.createElementNS(svgNS, 'path');
  head.setAttribute('d', 'M0,0 L10,5 L0,10 Z');
  head.setAttribute('class', 'board-arrow-head');
  marker.appendChild(head);
  defs.appendChild(marker);
  svg.appendChild(defs);

  // Pull the line endpoints back so they sit on the square edge rather than
  // the center, which gives a cleaner look against the existing piece.
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy) || 1;
  const padStart = 4;
  const padEnd = 5.5;
  const x1 = a.x + (dx / len) * padStart;
  const y1 = a.y + (dy / len) * padStart;
  const x2 = b.x - (dx / len) * padEnd;
  const y2 = b.y - (dy / len) * padEnd;

  const line = document.createElementNS(svgNS, 'line');
  line.setAttribute('x1', String(x1));
  line.setAttribute('y1', String(y1));
  line.setAttribute('x2', String(x2));
  line.setAttribute('y2', String(y2));
  line.setAttribute('class', 'board-arrow-line');
  line.setAttribute('marker-end', `url(#${arrowId})`);
  svg.appendChild(line);

  wrap.appendChild(svg);
  return wrap;
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
