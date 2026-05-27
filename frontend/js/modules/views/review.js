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
  loadingStateMarkup,
  esc,
  evalDeltaClass,
  fmt,
  mistakeTag,
  subtypeChip,
  subtypeLabel,
  resultBadge,
} from '../ui.js';
import { createDomCache } from '../dom.js';
import { endpoints, normalize } from '../contracts.js';

export function createReviewView({ api, apiContract, generateReport, onAskCoach, showView }) {
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
        ? `Mistake tag: ${mistake.type}, subtype: ${subtypeLabel(mistake.mistake_subtype)}, impact: ${mistake.practical_impact || 'unknown'}, eval loss: ${mistake.eval_loss}cp.`
        : 'No mistake tag is attached to this move.',
      mistake?.plan_text ? `Plan note: ${mistake.plan_text}` : '',
      '',
      'Explain what I missed in plain beginner language, then give me one concrete habit for my next game.',
    ].filter(Boolean).join('\n');
  }

  function candidateAlternativesMarkup(raw) {
    if (!raw) return '';
    let candidates = [];
    try {
      candidates = JSON.parse(raw);
    } catch {
      return '';
    }
    if (!Array.isArray(candidates) || !candidates.length) return '';
    return `
      <div class="detail-row">
        <span class="detail-label">Candidates:</span>
        <span class="flex flex-wrap gap-1">
          ${candidates.slice(0, 3).map((candidate) => `
            <span class="quality-pill" title="${candidate.eval_cp != null ? `${candidate.eval_cp}cp` : 'candidate'}">
              ${esc(candidate.san || candidate.uci || '—')}
            </span>
          `).join('')}
        </span>
      </div>
    `;
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
      currentMistake?.mistake_subtype
        ? `${subtypeLabel(currentMistake.mistake_subtype)} · ${currentMistake.practical_impact || 'impact unknown'} impact`
        : currentMistake?.type
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
    <span class="quality-pill">${move.phase || 'phase unknown'}</span>
    <span class="quality-pill">${move.classification || 'unclassified'}</span>
    <span class="${move.is_hanging_piece ? 'eval-pill text-[var(--warning)]' : 'quality-pill'}">${move.is_hanging_piece ? 'hanging piece' : 'piece safe'}</span>
    ${subtypeChip(currentMistake?.mistake_subtype)}
    ${currentMistake?.time_pressure_flag ? '<span class="quality-pill text-[var(--warning)]">time pressure</span>' : ''}
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

  function renderCriticalMistakesMarkup(mistakes, { interactive = false } = {}) {
    if (!mistakes.length) {
      return emptyStateMarkup('No significant mistakes found', '✓', true);
    }

    return mistakes
      .slice(0, 8)
      .map((mk) => `
            <button type="button" class="mistake-item${mk.is_critical ? (interactive ? ' is-critical' : ' active') : ''}"${
  interactive
    ? ` data-review-index="${mk.reviewIndex}" aria-label="Review mistake at move ${esc(mk.played_move)}"`
    : ''
}>
              <div class="mistake-item-header">
                ${mistakeTag(mk.type)}
                ${subtypeChip(mk.mistake_subtype)}
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
              ${mk.practical_impact || mk.confidence ? `<div class="detail-row">
                <span class="detail-label">Impact:</span>
                <span>${esc(mk.practical_impact || '—')}</span>
                <span class="detail-label">Confidence:</span>
                <span>${mk.confidence != null ? Math.round(Number(mk.confidence) * 100) + '%' : '—'}</span>
              </div>` : ''}
              ${candidateAlternativesMarkup(mk.candidate_alternatives)}
              ${mk.plan_text ? `<div class="critical-note">${esc(mk.plan_text)}</div>` : ''}
              ${mk.is_critical ? '<div class="critical-note">Critical moment — game turned here</div>' : ''}
            </button>
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
                  <tr class="${rowClass}">
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
                    <td><span class="quality-pill mtag-${esc(m.classification) || 'good'}" title="${esc(m.practical_impact ? `${m.practical_impact} impact` : 'Move quality')}">${
  m.classification || '—'
}</span></td>
                    <td class="cell-phase">${esc(m.phase) || '—'}</td>
                    <td><button class="btn btn-ghost btn-sm min-h-[44px] whitespace-nowrap px-[10px] text-xs" type="button" data-review-index="${m.reviewIndex}">Review</button></td>
                  </tr>
                `;
      })
      .join('');
  }

  function renderJournalMarkup(journal) {
    if (journal) {
      return `
  <div class="card panel-quiet mt-2">
    <div class="card-header flex items-center justify-between gap-3 border-b border-[var(--border)] px-4 py-3">
      <div class="card-title text-sm font-semibold text-[var(--text)]">Coach Note</div>
      <div class="text-xs text-[var(--muted)]">Generated by chess-coach AI</div>
    </div>
    <div class="whitespace-pre-wrap px-4 py-3 text-sm leading-relaxed text-[var(--text)]">${esc(journal.coach_note)}</div>
  </div>
`;
    }
    return `
  <div class="card panel-quiet mt-2 p-4">
    <div class="flex items-center justify-between gap-4">
      <div>
        <div class="text-sm font-semibold text-[var(--text)]">No coach note yet</div>
        <div class="mt-1 text-xs text-[var(--muted)]">Generate a coaching analysis for this game</div>
      </div>
      <button class="btn btn-primary btn-sm btn-generate-report">
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

      const target = event.target.closest('[data-review-index]');
      if (target) {
        setReviewMove(Number(target.dataset.reviewIndex));
      }
    });
  }

  async function loadGameDetail(gameId) {
    showView('game-detail');
    const targetUrl = `/games/${encodeURIComponent(gameId)}`;
    if (`${window.location.pathname}` !== targetUrl) {
      window.history.replaceState({ view: 'game-detail', gameId }, '', targetUrl);
    }
    const container = dom.byId('game-detail-content');
    container.innerHTML = loadingStateMarkup('Loading game review…');

    let data;
    try {
      data = await apiContract(endpoints.gameDetail(gameId), normalize.gameDetail, 'gameDetail');
    } catch (e) {
      container.innerHTML = errorStateMarkup('Failed to load game details. Please retry.');
      console.error('Failed to load game detail:', e);
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
    const mistakeCounts = mistakes.reduce(
      (acc, item) => {
        acc[item.type] = (acc[item.type] || 0) + 1;
        return acc;
      },
      { blunder: 0, mistake: 0, hanging_piece: 0, inaccuracy: 0 }
    );
    const avgEvalLoss = mistakes.length
      ? Math.round(mistakes.reduce((sum, item) => sum + (Number(item.eval_loss) || 0), 0) / mistakes.length)
      : 0;

    container.innerHTML = `
    <div class="game-meta-row hero-banner mb-4 flex flex-wrap items-center justify-between gap-3 p-4">
      <div class="flex min-w-0 flex-wrap items-center gap-2">
        <span class="active-pill">You · ${esc(g.color)}</span>
        <span class="quality-pill">Opponent ${esc(g.opponent_rating || '?')}</span>
        ${resultBadge(g.result)}
        <span class="opening-pill badge badge-outline badge-sm">${esc(g.opening_eco || '?')}</span>
        <span class="game-meta-detail text-[13px]">${
  esc(g.opening_name || 'Unknown opening')
}</span>
      </div>
      <span class="meta-label">${fmt(g.date)}</span>
    </div>

    <div class="review-workspace split-analysis-layout mb-3">
      <section class="review-stage panel-primary p-5 max-sm:p-3">
        <div class="review-header flex flex-wrap items-start justify-between gap-2">
          <div>
            <div class="section-kicker">Review Workspace</div>
            <div class="review-title mt-1 text-[28px] font-extrabold leading-tight" id="review-title">Move</div>
            <div class="review-caption mt-1 text-[12px] text-[var(--muted)]" id="review-caption">Position before your move</div>
          </div>
          <div class="review-badges flex flex-wrap gap-1" id="review-badges"></div>
        </div>

        <div class="review-board-shell board-stage mt-2">
          <div class="engine-eval-bar" aria-hidden="true"></div>
          <div id="review-board"></div>
        </div>

        <div class="review-toolbar mt-2 flex flex-wrap items-center justify-between gap-2 max-sm:items-start">
          <div class="review-nav flex flex-wrap gap-1 max-sm:grid max-sm:w-full max-sm:grid-cols-2">
            <button class="btn btn-ghost btn-sm min-h-[40px]" id="review-prev">← Prev</button>
            <button class="btn btn-ghost btn-sm min-h-[40px]" id="review-next">Next →</button>
            <button class="btn btn-ghost btn-sm min-h-[40px]" id="review-critical">Critical</button>
            <button class="btn btn-ghost btn-sm min-h-[40px]" id="review-flip">Flip Board</button>
            <button class="btn btn-primary btn-sm min-h-[40px] max-sm:col-span-2" id="review-ask-coach">Ask Coach</button>
          </div>
          <div class="meta-label" id="review-counter"></div>
        </div>

        <div class="review-scrubber-row mt-1 flex items-center gap-[12px] max-sm:flex-col max-sm:items-stretch">
          <span class="meta-label">Move</span>
          <input
            type="range"
            id="review-scrubber"
            class="review-scrubber range range-sm w-full"
            min="0"
            max="${Math.max(reviewState.playerMoves.length - 1, 0)}"
            value="${reviewState.selectedIndex}"
          />
        </div>

        <div class="review-choice-grid mt-2 grid gap-2 [grid-template-columns:repeat(3,minmax(0,1fr))] max-md:[grid-template-columns:1fr]">
          <button class="review-choice active rounded-cc border border-[var(--border)] bg-[var(--surface-2)] p-3 text-left transition-colors duration-150 hover:border-[var(--blue)]" data-review-mode="before" type="button">
            <div class="review-choice-label text-[11px] font-bold uppercase tracking-[0.08em] text-[var(--muted)]">Position</div>
            <div class="review-choice-value mt-1 text-[15px] font-semibold" id="review-position-label">Current position</div>
            <div class="review-choice-meta mt-[4px] text-[11px] text-[var(--muted)]" id="review-position-meta">Review the position before your move</div>
          </button>
          <button class="review-choice rounded-cc border border-[var(--border)] bg-[var(--surface-2)] p-3 text-left transition-colors duration-150 hover:border-[var(--blue)]" data-review-mode="played" type="button">
            <div class="review-choice-label text-[11px] font-bold uppercase tracking-[0.08em] text-[var(--muted)]">Played</div>
            <div class="review-choice-value mt-1 text-[15px] font-semibold" id="review-played-label">—</div>
            <div class="review-choice-meta mt-[4px] text-[11px] text-[var(--muted)]" id="review-played-meta">Your move</div>
          </button>
          <button class="review-choice rounded-cc border border-[var(--border)] bg-[var(--surface-2)] p-3 text-left transition-colors duration-150 hover:border-[var(--blue)]" data-review-mode="best" type="button">
            <div class="review-choice-label text-[11px] font-bold uppercase tracking-[0.08em] text-[var(--muted)]">Best</div>
            <div class="review-choice-value mt-1 text-[15px] font-semibold" id="review-best-label">—</div>
            <div class="review-choice-meta mt-[4px] text-[11px] text-[var(--muted)]" id="review-best-meta">Engine line</div>
          </button>
        </div>
      </section>

      <aside class="mistake-panel review-analysis-panel flex flex-col gap-2">
        <div class="engine-panel p-4">
          <div class="section-kicker">Move Accuracy</div>
          <div class="mt-3 grid grid-cols-2 gap-2">
            <div class="eval-pill justify-between text-[var(--warning)]"><span>Inaccuracies</span><strong>${mistakeCounts.inaccuracy || 0}</strong></div>
            <div class="eval-pill justify-between text-[#ff8c42]"><span>Mistakes</span><strong>${mistakeCounts.mistake || 0}</strong></div>
            <div class="eval-pill justify-between text-[var(--error)]"><span>Blunders</span><strong>${mistakeCounts.blunder || 0}</strong></div>
            <div class="eval-pill justify-between text-[var(--primary)]"><span>Avg loss</span><strong>${avgEvalLoss}cp</strong></div>
          </div>
        </div>
        <div class="review-side-card analytics-panel p-4">
          <div class="review-side-title text-[13px] font-semibold">Move Summary</div>
          <div class="review-summary-list mt-2 grid gap-[10px]">
            <div class="review-summary-row flex items-center justify-between gap-2 border-b border-[var(--border)] pb-2">
              <span class="review-summary-label text-[12px] text-[var(--muted)]">Phase</span>
              <span class="review-summary-value text-right text-[12px] font-semibold" id="review-summary-phase">—</span>
            </div>
            <div class="review-summary-row flex items-center justify-between gap-2 border-b border-[var(--border)] pb-2">
              <span class="review-summary-label text-[12px] text-[var(--muted)]">Quality</span>
              <span class="review-summary-value text-right text-[12px] font-semibold" id="review-summary-quality">—</span>
            </div>
            <div class="review-summary-row flex items-center justify-between gap-2 border-b border-[var(--border)] pb-2">
              <span class="review-summary-label text-[12px] text-[var(--muted)]">Eval Δ</span>
              <span class="review-summary-value text-right text-[12px] font-semibold" id="review-summary-eval">—</span>
            </div>
            <div class="review-summary-row flex items-center justify-between gap-2 border-b border-[var(--border)] pb-2">
              <span class="review-summary-label text-[12px] text-[var(--muted)]">Played</span>
              <span class="review-summary-value cell-code text-right text-[12px] font-semibold" id="review-summary-played">—</span>
            </div>
            <div class="review-summary-row flex items-center justify-between gap-2">
              <span class="review-summary-label text-[12px] text-[var(--muted)]">Best</span>
              <span class="review-summary-value cell-code text-right text-[12px] font-semibold" id="review-summary-best">—</span>
            </div>
          </div>
        </div>

        <div class="mistake-panel-title section-kicker mt-1">
          Critical Mistakes (${reviewState.mistakes.length})
        </div>
        ${reviewMistakesMarkup}
      </aside>
    </div>

    <div class="game-detail-grid grid items-start gap-3 [grid-template-columns:minmax(0,1fr)_340px] max-md:[grid-template-columns:1fr]">
      <div>
        <div class="card analytics-panel">
          <div class="card-header flex items-center justify-between gap-2 border-b border-[var(--border)] px-3 py-2">
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
                <th>Action</th>
              </tr>
            </thead>
            <tbody>
              ${playerMovesTableMarkup}
            </tbody>
          </table>
        </div>
      </div>

      <div class="mistake-panel flex flex-col gap-2">
        <div class="mistake-panel-title section-kicker">
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
