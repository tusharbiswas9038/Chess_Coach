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
        lbl.className = 'sq-label-file';
        lbl.textContent = f;
        lbl.style.color = isLight ? '#b58863' : '#f0d9b5';
        cell.appendChild(lbl);
      }

      if (flipped ? f === 'h' : f === 'a') {
        const lbl = document.createElement('div');
        lbl.className = 'sq-label-rank';
        lbl.textContent = rank;
        lbl.style.color = isLight ? '#b58863' : '#f0d9b5';
        cell.appendChild(lbl);
      }

      const piece = position[sq];
      if (piece && PIECES[piece]) {
        const pieceEl = document.createElement('div');
        pieceEl.className = 'piece';
        pieceEl.textContent = PIECES[piece];
        pieceEl.style.color = piece[0] === 'w' ? '#fff' : '#1a1a1a';
        pieceEl.style.textShadow =
          piece[0] === 'w'
            ? '0 1px 3px rgba(0,0,0,0.8)'
            : '0 1px 2px rgba(255,255,255,0.2)';
        cell.appendChild(pieceEl);
      }

      if (onSquareClick) {
        cell.addEventListener('click', () => onSquareClick(sq));
      }
      grid.appendChild(cell);
    }
  }
  board.appendChild(grid);
}
