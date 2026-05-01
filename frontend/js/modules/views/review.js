import {
  applyMove,
  fenTurn,
  parseFen,
  parseUCI,
  renderPositionBoard,
} from '../board.js';
import {
  colorBadge,
  emptyStateMarkup,
  errorStateMarkup,
  esc,
  evalDeltaClass,
  fmt,
  mistakeTag,
  resultBadge,
} from '../ui.js';
import { createDomCache } from '../dom.js';

export function createReviewView({ api, generateReport, onAskCoach, showView }) {
  const dom = createDomCache();
  let reviewState = null;
  let reviewDelegatedEventsBound = false;

  function movePrefix(move) {
    if (!move) return '—';
    return move.color === 'black' ? `${move.move_number}...` : `${move.move_number}.`;
  }

  function enrichMistakesWithReviewIndex(playerMoves, mistakes) {
    return mistakes.map((mistake) => ({
      ...mistake,
      reviewIndex: playerMoves.findIndex((move) => move.uci === mistake.played_move),
    }));
  }

  function createReviewState(game, moves, mistakes) {
    const playerMoves = moves
      .filter((move) => move.color === game.color)
      .map((move, reviewIndex) => ({ ...move, reviewIndex }));
    const enrichedMistakes = enrichMistakesWithReviewIndex(playerMoves, mistakes);
    const criticalIndex = enrichedMistakes.find((mistake) => mistake.is_critical)?.reviewIndex ?? -1;
    const fallbackIndex = playerMoves.length > 0 ? playerMoves.length - 1 : 0;

    return {
      game,
      moves,
      playerMoves,
      mistakes: enrichedMistakes,
      selectedIndex: criticalIndex >= 0 ? criticalIndex : fallbackIndex,
      criticalIndex,
      flipped: game.color === 'black',
      mode: 'before',
    };
  }

  function currentReviewMove() {
    if (!reviewState || !reviewState.playerMoves.length) return null;
    return reviewState.playerMoves[reviewState.selectedIndex] || null;
  }

  function buildCoachPrompt() {
    if (!reviewState) return '';
    const move = currentReviewMove();
    if (!move) return '';
    const game = reviewState.game;
    const mistake = reviewState.mistakes.find(
      (item) => item.reviewIndex === move.reviewIndex
    );

    return [
      'Coach me on this exact game moment.',
      '',
      `Game: I played ${game.color} vs ${game.opponent_rating || '?'} rated opponent.`,
      `Result: ${game.result}.`,
      `Opening: ${game.opening_name || 'Unknown'} (${game.opening_eco || '?'}).`,
      `Move under review: ${movePrefix(move)} ${move.san} (${move.uci}).`,
      `Move quality: ${move.classification || 'unclassified'}, phase: ${move.phase || 'unknown'}.`,
      `Eval change: ${move.eval_delta != null ? move.eval_delta + 'cp' : 'unknown'}.`,
      `Engine recommendation: ${move.best_move_san || move.best_move_uci || 'unknown'}.`,
      mistake
        ? `Mistake tag: ${mistake.type}, eval loss: ${mistake.eval_loss}cp.`
        : 'No mistake tag is attached to this move.',
      '',
      'Explain what I missed in plain beginner language, then give me one concrete habit for my next game.',
    ].join('\n');
  }

  function reviewModeConfig(move) {
    if (!move) {
      return {
        position: {},
        caption: 'No move selected',
        from: null,
        to: null,
      };
    }

    if (reviewState.mode === 'played') {
      const played = parseUCI(move.uci);
      return {
        position: parseFen(move.fen_after),
        caption: `After your move ${move.san}`,
        from: played.from,
        to: played.to,
      };
    }

    if (reviewState.mode === 'best' && move.best_move_uci && move.best_move_uci !== move.uci) {
      const best = parseUCI(move.best_move_uci);
      return {
        position: applyMove(parseFen(move.fen_before), move.best_move_uci, fenTurn(move.fen_before)),
        caption: `Best-move preview: ${move.best_move_san || move.best_move_uci}`,
        from: best.from,
        to: best.to,
      };
    }

    const played = parseUCI(move.uci);
    return {
      position: parseFen(move.fen_before),
      caption: 'Position before your move',
      from: played.from,
      to: played.to,
    };
  }

  function renderReviewBoard() {
    const move = currentReviewMove();
    if (!move) return;
    const config = reviewModeConfig(move);
    renderPositionBoard('review-board', config.position, {
      flipped: reviewState.flipped,
      lastFrom: config.from,
      lastTo: config.to,
    });
    dom.byId('review-caption').textContent = config.caption;
  }

  function updateReviewSelectionStyles(move) {
    dom.queryAll('[data-review-index]').forEach((el) => {
      el.classList.toggle(
        'active',
        Number(el.dataset.reviewIndex) === reviewState.selectedIndex
      );
      if (el.tagName === 'TR') {
        el.classList.toggle(
          'review-row-active',
          Number(el.dataset.reviewIndex) === reviewState.selectedIndex
        );
      }
    });

    dom.queryAll('[data-review-mode]').forEach((el) => {
      el.classList.toggle('active', el.dataset.reviewMode === reviewState.mode);
    });

    const criticalBtn = dom.byId('review-critical');
    if (criticalBtn) criticalBtn.disabled = reviewState.criticalIndex < 0;

    const prevBtn = dom.byId('review-prev');
    const nextBtn = dom.byId('review-next');
    if (prevBtn) prevBtn.disabled = reviewState.selectedIndex <= 0;
    if (nextBtn) nextBtn.disabled = reviewState.selectedIndex >= reviewState.playerMoves.length - 1;

    const scrubber = dom.byId('review-scrubber');
    if (scrubber) {
      scrubber.max = String(Math.max(reviewState.playerMoves.length - 1, 0));
      scrubber.value = String(reviewState.selectedIndex);
    }

    const bestToggle = dom.query('[data-review-mode="best"]');
    const bestAvailable = move?.best_move_san && move.best_move_san !== move.san;
    if (bestToggle) {
      bestToggle.disabled = !bestAvailable;
      if (!bestAvailable && reviewState.mode === 'best') {
        reviewState.mode = 'before';
        dom.query('[data-review-mode="before"]')?.classList.add('active');
      }
    }
  }

  function renderReviewWorkspace() {
    const move = currentReviewMove();
    if (!move) return;

    const title = `${movePrefix(move)} ${move.san}`;
    const counter = `${reviewState.selectedIndex + 1} / ${reviewState.playerMoves.length} of your moves`;
    const evalText =
      move.eval_delta != null
        ? `${move.eval_delta > 0 ? '+' : ''}${move.eval_delta}cp`
        : '—';
    const evalClass = evalDeltaClass(move.eval_delta);
    const bestText =
      move.best_move_san && move.best_move_san !== move.san
        ? move.best_move_san
        : 'Already best';
    const currentMistake = reviewState.mistakes.find(
      (mistake) => mistake.reviewIndex === move.reviewIndex
    );

    dom.byId('review-title').textContent = title;
    dom.byId('review-counter').textContent = counter;
    dom.byId('review-played-label').textContent = move.san;
    dom.byId('review-played-meta').textContent =
      move.eval_delta != null ? `${Math.abs(move.eval_delta)}cp swing` : 'No eval swing available';
    dom.byId('review-best-label').textContent = bestText;
    dom.byId('review-best-meta').textContent =
      move.best_move_san && move.best_move_san !== move.san
        ? 'Preview the engine recommendation'
        : 'No better alternative stored';
    dom.byId('review-position-label').textContent =
      currentMistake?.is_critical ? 'Critical position' : 'Current position';
    dom.byId('review-position-meta').textContent =
      currentMistake?.type
        ? `Mistake type: ${currentMistake.type.replace('_', ' ')}`
        : 'Review the position before your move';

    dom.byId('review-summary-phase').textContent = move.phase || '—';
    dom.byId('review-summary-quality').textContent =
      move.classification || '—';
    dom.byId('review-summary-played').textContent = move.san;
    dom.byId('review-summary-best').textContent = bestText;
    const evalEl = dom.byId('review-summary-eval');
    evalEl.textContent = evalText;
    evalEl.className = `review-summary-value ${evalClass}`;

    dom.byId('review-badges').innerHTML = `
    <span class="review-pill">${move.phase || 'phase unknown'}</span>
    <span class="review-pill">${move.classification || 'unclassified'}</span>
    <span class="review-pill">${move.is_hanging_piece ? 'hanging piece' : 'piece safe'}</span>
  `;

    updateReviewSelectionStyles(move);
    renderReviewBoard();
  }

  function setReviewMove(index) {
    if (!reviewState || !reviewState.playerMoves.length) return;
    reviewState.selectedIndex = Math.max(
      0,
      Math.min(index, reviewState.playerMoves.length - 1)
    );
    if (reviewState.mode === 'best') {
      const move = currentReviewMove();
      if (!move?.best_move_san || move.best_move_san === move.san) {
        reviewState.mode = 'before';
      }
    }
    renderReviewWorkspace();
  }

  function setReviewMode(mode) {
    if (!reviewState) return;
    reviewState.mode = mode;
    renderReviewWorkspace();
  }

  function isActivationKey(event) {
    return event.key === 'Enter' || event.key === ' ';
  }

  function renderCriticalMistakesMarkup(mistakes, { interactive = false } = {}) {
    if (!mistakes.length) {
      return emptyStateMarkup('No significant mistakes found', '✓', true);
    }

    return mistakes
      .slice(0, 8)
      .map((mk) => `
            <div class="mistake-item${mk.is_critical ? (interactive ? ' is-critical' : ' active') : ''}"${
  interactive
    ? ` data-review-index="${mk.reviewIndex}" tabindex="0" role="button" aria-label="Review mistake at move ${esc(mk.played_move)}"`
    : ''
}>
              <div class="mistake-item-header">
                ${mistakeTag(mk.type)}
                <div class="eval-loss">-${mk.eval_loss}cp</div>
              </div>
              <div class="detail-row">
                <span class="detail-label">Phase:</span>
                <span>${esc(mk.phase) || '—'}</span>
              </div>
              <div class="detail-row">
                <span class="detail-label">Played:</span>
                <span class="cell-code text-error">${esc(mk.played_move)}</span>
                <span class="detail-label">→ Better:</span>
                <span class="cell-code text-success">${esc(mk.best_move)}</span>
              </div>
              ${mk.is_critical ? '<div class="critical-note">⚡ Critical moment — game turned here</div>' : ''}
            </div>
          `)
      .join('');
  }

  function renderPlayerMovesTableMarkup() {
    return reviewState.playerMoves
      .map((m) => {
        const isCritical = reviewState.mistakes.find(
          (mk) => mk.is_critical && mk.reviewIndex === m.reviewIndex
        );
        const rowClass = isCritical
          ? 'critical-row'
          : m.is_hanging_piece === 1
            ? 'hanging-row'
            : '';
        const qClass = `move-${m.classification || 'good'}`;
        const delta =
          m.eval_delta != null
            ? (m.eval_delta > 0 ? '+' : '') + m.eval_delta
            : '—';
        return `
                  <tr class="${rowClass}" data-review-index="${m.reviewIndex}" tabindex="0" role="button" aria-label="Review move ${esc(m.san)}">
                    <td class="cell-muted">${m.move_number}.</td>
                    <td class="${qClass} cell-code-strong">${esc(m.san)}</td>
                    <td class="cell-code cell-muted">
                      ${
  m.best_move_san && m.best_move_san !== m.san
    ? `<span class="text-success">${esc(m.best_move_san)}</span>`
    : '—'
}
                    </td>
                    <td class="${evalDeltaClass(m.eval_delta)}">${delta}</td>
                    <td><span class="mtag mtag-${esc(m.classification) || 'good'}">${
  m.classification || '—'
}</span></td>
                    <td class="cell-phase">${esc(m.phase) || '—'}</td>
                  </tr>
                `;
      })
      .join('');
  }

  function renderJournalMarkup(journal) {
    if (journal) {
      return `
  <div class="card card-top-gap">
    <div class="card-header">
      <div class="card-title">🧠 Coach Note</div>
      <div class="journal-meta">Generated by chess-coach AI</div>
    </div>
    <div class="journal-content">${esc(journal.coach_note)}</div>
  </div>
`;
    }
    return `
  <div class="card card-top-gap card-body">
    <div class="journal-empty-row">
      <div>
        <div class="journal-empty-title">No coach note yet</div>
        <div class="journal-empty-subtitle">Generate a coaching analysis for this game</div>
      </div>
      <button class="btn btn-primary btn-generate-report">
        Generate Report
      </button>
    </div>
  </div>
`;
  }

  function attachGameDetailEvents(container, gameId) {
    container.querySelector('.btn-generate-report')?.addEventListener('click', () => generateReport(gameId));
    container.querySelector('#review-prev')?.addEventListener('click', () => {
      setReviewMove(reviewState.selectedIndex - 1);
    });
    container.querySelector('#review-next')?.addEventListener('click', () => {
      setReviewMove(reviewState.selectedIndex + 1);
    });
    container.querySelector('#review-critical')?.addEventListener('click', () => {
      if (reviewState.criticalIndex >= 0) setReviewMove(reviewState.criticalIndex);
    });
    container.querySelector('#review-flip')?.addEventListener('click', () => {
      reviewState.flipped = !reviewState.flipped;
      renderReviewBoard();
    });
    container.querySelector('#review-ask-coach')?.addEventListener('click', () => {
      onAskCoach(buildCoachPrompt());
    });
    container.querySelector('#review-scrubber')?.addEventListener('input', (event) => {
      setReviewMove(Number(event.target.value));
    });
    if (reviewDelegatedEventsBound) return;
    reviewDelegatedEventsBound = true;

    container.addEventListener('click', (event) => {
      const modeBtn = event.target.closest('[data-review-mode]');
      if (modeBtn && !modeBtn.disabled) {
        setReviewMode(modeBtn.dataset.reviewMode);
        return;
      }

      const row = event.target.closest('tr[data-review-index]');
      if (row) {
        setReviewMove(Number(row.dataset.reviewIndex));
        return;
      }

      const item = event.target.closest('.mistake-item[data-review-index]');
      if (item) {
        setReviewMove(Number(item.dataset.reviewIndex));
      }
    });

    container.addEventListener('keydown', (event) => {
      if (!isActivationKey(event)) return;

      const row = event.target.closest('tr[data-review-index]');
      if (row) {
        event.preventDefault();
        setReviewMove(Number(row.dataset.reviewIndex));
        return;
      }

      const item = event.target.closest('.mistake-item[data-review-index]');
      if (item) {
        event.preventDefault();
        setReviewMove(Number(item.dataset.reviewIndex));
        return;
      }

      const modeBtn = event.target.closest('[data-review-mode]');
      if (modeBtn && !modeBtn.disabled) {
        event.preventDefault();
        setReviewMode(modeBtn.dataset.reviewMode);
      }
    });
  }

  async function loadGameDetail(gameId) {
    showView('game-detail');
    const container = dom.byId('game-detail-content');
    container.innerHTML = '<div class="skeleton skeleton-tall"></div>';

    let data;
    try {
      data = await api(`/api/games/${gameId}`);
    } catch (e) {
      container.innerHTML = errorStateMarkup(`Failed to load game: ${e.message}`);
      return;
    }

    const g = data.game;
    const mistakes = data.mistakes || [];
    const moves = data.moves || [];
    reviewState = createReviewState(g, moves, mistakes);

    if (!reviewState.playerMoves.length) {
      container.innerHTML = emptyStateMarkup('No player moves available for review.');
      return;
    }

    const reviewMistakesMarkup = renderCriticalMistakesMarkup(reviewState.mistakes, {
      interactive: true,
    });
    const summaryMistakesMarkup = renderCriticalMistakesMarkup(mistakes);
    const playerMovesTableMarkup = renderPlayerMovesTableMarkup();
    const journalMarkup = renderJournalMarkup(data.journal);

    container.innerHTML = `
    <div class="game-meta-row">
      ${colorBadge(g.color)}
      ${resultBadge(g.result)}
      <span class="opening-pill">${esc(g.opening_eco || '?')}</span>
      <span class="game-meta-detail">${
  esc(g.opening_name || 'Unknown opening')
}</span>
      <span class="meta-label">${fmt(g.date)}</span>
      <span class="meta-label">vs. ${
  esc(g.opponent_rating || '?')
} rated</span>
    </div>

    <div class="review-workspace">
      <section class="review-stage">
        <div class="review-header">
          <div>
            <div class="section-kicker">Review Workspace</div>
            <div class="review-title" id="review-title">Move</div>
            <div class="review-caption" id="review-caption">Position before your move</div>
          </div>
          <div class="review-badges" id="review-badges"></div>
        </div>

        <div class="review-board-shell">
          <div id="review-board"></div>
        </div>

        <div class="review-toolbar">
          <div class="review-nav">
            <button class="btn btn-ghost" id="review-prev">← Prev</button>
            <button class="btn btn-ghost" id="review-next">Next →</button>
            <button class="btn btn-ghost" id="review-critical">Critical</button>
            <button class="btn btn-ghost" id="review-flip">Flip Board</button>
            <button class="btn btn-primary" id="review-ask-coach">Ask Coach</button>
          </div>
          <div class="meta-label" id="review-counter"></div>
        </div>

        <div class="review-scrubber-row">
          <span class="meta-label">Move</span>
          <input
            type="range"
            id="review-scrubber"
            class="review-scrubber"
            min="0"
            max="${Math.max(reviewState.playerMoves.length - 1, 0)}"
            value="${reviewState.selectedIndex}"
          />
        </div>

        <div class="review-choice-grid">
          <button class="review-choice active" data-review-mode="before" type="button">
            <div class="review-choice-label">Position</div>
            <div class="review-choice-value" id="review-position-label">Current position</div>
            <div class="review-choice-meta" id="review-position-meta">Review the position before your move</div>
          </button>
          <button class="review-choice" data-review-mode="played" type="button">
            <div class="review-choice-label">Played</div>
            <div class="review-choice-value" id="review-played-label">—</div>
            <div class="review-choice-meta" id="review-played-meta">Your move</div>
          </button>
          <button class="review-choice" data-review-mode="best" type="button">
            <div class="review-choice-label">Best</div>
            <div class="review-choice-value" id="review-best-label">—</div>
            <div class="review-choice-meta" id="review-best-meta">Engine line</div>
          </button>
        </div>
      </section>

      <aside class="mistake-panel">
        <div class="review-side-card">
          <div class="review-side-title">Move Summary</div>
          <div class="review-summary-list">
            <div class="review-summary-row">
              <span class="review-summary-label">Phase</span>
              <span class="review-summary-value" id="review-summary-phase">—</span>
            </div>
            <div class="review-summary-row">
              <span class="review-summary-label">Quality</span>
              <span class="review-summary-value" id="review-summary-quality">—</span>
            </div>
            <div class="review-summary-row">
              <span class="review-summary-label">Eval Δ</span>
              <span class="review-summary-value" id="review-summary-eval">—</span>
            </div>
            <div class="review-summary-row">
              <span class="review-summary-label">Played</span>
              <span class="review-summary-value cell-code" id="review-summary-played">—</span>
            </div>
            <div class="review-summary-row">
              <span class="review-summary-label">Best</span>
              <span class="review-summary-value cell-code" id="review-summary-best">—</span>
            </div>
          </div>
        </div>

        <div class="mistake-panel-title">
          Critical Mistakes (${reviewState.mistakes.length})
        </div>
        ${reviewMistakesMarkup}
      </aside>
    </div>

    <div class="game-detail-grid">
      <div>
        <div class="card">
          <div class="card-header">
            <div class="card-title">Your Moves Analysis</div>
            <div class="table-meta">${
  reviewState.playerMoves.length
} moves · ${reviewState.mistakes.length} mistakes</div>
          </div>
          <table>
            <thead>
              <tr>
                <th>#</th>
                <th>Move</th>
                <th>Best Was</th>
                <th>Eval Δ</th>
                <th>Quality</th>
                <th>Phase</th>
              </tr>
            </thead>
            <tbody>
              ${playerMovesTableMarkup}
            </tbody>
          </table>
        </div>
      </div>

      <div class="mistake-panel">
        <div class="mistake-panel-title">
          Critical Mistakes (${mistakes.length})
        </div>
        ${summaryMistakesMarkup}
      </div>
    </div>
    ${journalMarkup}
  `;
    attachGameDetailEvents(container, gameId);
    renderReviewWorkspace();
  }

  return {
    buildCoachPrompt,
    loadGameDetail,
  };
}
