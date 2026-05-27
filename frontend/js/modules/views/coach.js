import { createDomCache } from '../dom.js';
import { endpoints } from '../contracts.js';

export function createCoachView({
  apiPost,
  buildReviewCoachPrompt,
  getStatsData,
  showView,
  toast,
}) {
  const dom = createDomCache();
  let coachHistory = [];
  let coachBusy = false;
  const EXTRA_PROMPTS = [
    { text: 'Build me a 7-day improvement plan using my current weaknesses.', mode: 'deep_lesson' },
    { text: 'Give me opening prep priorities for my next rapid session.', mode: 'pre_game_prep' },
    { text: 'I just lost two games. Give me a 10-minute reset routine before I play again.', mode: 'post_loss_reset' },
  ];

  function updateContext() {
    const statsData = getStatsData();
    const profile = statsData?.profile || {};
    const hRate = statsData ? (statsData.hanging_piece_rate * 100).toFixed(1) + '%' : '—';
    dom.byId('coach-context-rating').textContent =
      profile.current_rating || '—';
    dom.byId('coach-context-games').textContent =
      statsData?.games?.analyzed?.toLocaleString?.() || '—';
    dom.byId('coach-context-hanging').textContent = hRate;
    dom.byId('coach-context-blunders').textContent =
      statsData?.blunders_per_game ?? '—';
    dom.byId('coach-context-drills').textContent =
      statsData?.drills_due ?? '—';
  }

  function renderMessages(pending = false) {
    const container = dom.byId('coach-messages');
    if (!coachHistory.length && !pending) {
      container.innerHTML = `
        <div class="coach-empty space-y-3">
          <cc-empty-state title="No coach conversation yet" icon="♟"></cc-empty-state>
          <div class="coach-empty-copy text-sm text-[var(--muted)]">
            Pick a prompt or ask a direct question. The coach will use your current chess data as context.
          </div>
          <div class="coach-mode-grid" aria-hidden="true">
            <div class="coach-mode-chip">Game Review</div>
            <div class="coach-mode-chip">Opening Prep</div>
            <div class="coach-mode-chip">Training Plan</div>
          </div>
        </div>
      `;
      return;
    }

    container.textContent = '';
    coachHistory.forEach((message, index) => {
      const role = message?.role === 'user' ? 'user' : 'assistant';
      const row = document.createElement('div');
      row.className = `coach-message coach-message-${role} mb-3 flex flex-col ${role === 'user' ? 'items-end' : 'items-start'}`;

      const bubble = document.createElement('div');
      bubble.className =
        'coach-bubble max-w-[92%] rounded-cc border border-[var(--border)] bg-[var(--surface-2)] px-3 py-2 text-sm leading-relaxed whitespace-pre-wrap';
      bubble.textContent = String(message?.content || '');
      row.appendChild(bubble);

      if (role === 'assistant' && message?.sessionId) {
        const fb = document.createElement('div');
        fb.className = 'coach-feedback mt-1 flex items-center gap-1 text-xs text-[var(--muted)]';
        fb.dataset.sessionId = String(message.sessionId);
        const rated = message.rating;
        const helpfulActive = rated === 1 ? ' is-active' : '';
        const notHelpfulActive = rated === -1 ? ' is-active' : '';
        fb.innerHTML = `
          <span class="coach-feedback-label">Was this helpful?</span>
          <button type="button" class="coach-feedback-btn coach-feedback-up${helpfulActive}" data-rating="1" aria-label="Helpful" aria-pressed="${rated === 1}">👍</button>
          <button type="button" class="coach-feedback-btn coach-feedback-down${notHelpfulActive}" data-rating="-1" aria-label="Not helpful" aria-pressed="${rated === -1}">👎</button>
        `;
        row.appendChild(fb);
      }

      container.appendChild(row);
    });

    if (pending) {
      const row = document.createElement('div');
      row.className = 'coach-message coach-message-assistant coach-message-pending mb-3 flex justify-start';
      const bubble = document.createElement('div');
      bubble.className =
        'coach-bubble max-w-[92%] rounded-cc border border-[var(--border)] bg-[var(--surface-2)] px-3 py-2 text-sm whitespace-pre-wrap';
      bubble.textContent = 'Coach is thinking…';
      row.appendChild(bubble);
      container.appendChild(row);
    }
    container.scrollTop = container.scrollHeight;
  }

  function setBusy(isBusy) {
    coachBusy = isBusy;
    dom.byId('btn-coach-send').disabled = isBusy;
    dom.byId('coach-input').disabled = isBusy;
    dom.byId('coach-status').textContent =
      isBusy ? 'Waiting for coach…' : 'Ready';
  }

  function init() {
    updateContext();
    renderMessages();
  }

  function setCoachMode(mode) {
    const select = dom.byId('coach-mode');
    if (select && mode) select.value = mode;
  }

  function getCoachMode() {
    return dom.byId('coach-mode')?.value || 'quick_answer';
  }

  function draftQuestion(text, mode = '') {
    showView('coach');
    setCoachMode(mode);
    const input = dom.byId('coach-input');
    const stats = getStatsData() || {};
    const profile = stats.profile || {};
    const contextual = [
      `Context: rating ${profile.current_rating || 'unknown'}, blunders/game ${stats.blunders_per_game ?? 'unknown'}, drills due ${stats.drills_due ?? 'unknown'}.`,
      text,
    ].join('\n');
    input.value = contextual;
    input.focus();
    dom.byId('coach-status').textContent = 'Draft ready';
  }

  function clearChat() {
    coachHistory = [];
    renderMessages();
    dom.byId('coach-status').textContent = 'Ready';
  }

  async function handleSubmit(event) {
    event.preventDefault();
    const input = dom.byId('coach-input');
    const message = input.value.trim();
    if (!message || coachBusy) return;

    const apiHistory = coachHistory.slice(-10).map(({ role, content }) => ({
      role,
      content,
    }));
    coachHistory.push({ role: 'user', content: message });
    input.value = '';
    setBusy(true);
    renderMessages(true);

    try {
      const result = await apiPost(endpoints.coachChat(), {
        message,
        history: apiHistory,
        mode: getCoachMode(),
      });
      coachHistory.push({
        role: 'assistant',
        content: result.reply || 'No reply returned.',
        sessionId: result.session_id || null,
        rating: 0,
      });
    } catch (e) {
      coachHistory.push({
        role: 'assistant',
        content: 'I could not reach the coach model right now. Please try again.',
      });
      toast('Coach chat failed: ' + e.message);
    } finally {
      setBusy(false);
      renderMessages();
    }
  }

  function bindEvents() {
    dom.byId('coach-form').addEventListener('submit', handleSubmit);
    dom.byId('btn-coach-clear').addEventListener('click', clearChat);
    dom.byId('coach-messages')?.addEventListener('click', async (event) => {
      const btn = event.target.closest('.coach-feedback-btn');
      if (!btn) return;
      const wrap = btn.closest('.coach-feedback');
      const sessionId = Number(wrap?.dataset.sessionId || 0);
      if (!sessionId) return;
      const rating = Number(btn.dataset.rating);
      const wasActive = btn.classList.contains('is-active');
      const finalRating = wasActive ? 0 : rating;
      try {
        await apiPost(endpoints.coachFeedback(), { session_id: sessionId, rating: finalRating });
      } catch (e) {
        toast('Could not save feedback: ' + e.message);
        return;
      }
      // mirror state into history so it sticks across re-renders
      const target = coachHistory.find((m) => m?.sessionId === sessionId);
      if (target) target.rating = finalRating;
      // visual update without full re-render
      wrap.querySelectorAll('.coach-feedback-btn').forEach((b) => {
        const rate = Number(b.dataset.rating);
        const active = rate === finalRating;
        b.classList.toggle('is-active', active);
        b.setAttribute('aria-pressed', String(active));
      });
    });
    dom.query('.coach-prompt-list')?.addEventListener('click', (event) => {
      const btn = event.target.closest('[data-coach-prompt]');
      if (!btn) return;
      draftQuestion(btn.dataset.coachPrompt, btn.dataset.coachMode);
    });
    const promptList = dom.query('.coach-prompt-list');
    if (promptList && !promptList.dataset.enhanced) {
      EXTRA_PROMPTS.forEach((prompt) => {
        const b = document.createElement('button');
        b.className =
          'coach-prompt btn btn-ghost w-full justify-start rounded-xl border border-[var(--border)] bg-[var(--surface-2)] px-3 py-2 text-left normal-case text-[13px]';
        b.type = 'button';
        b.dataset.coachPrompt = prompt.text;
        b.dataset.coachMode = prompt.mode;
        b.textContent = prompt.text.length > 46 ? `${prompt.text.slice(0, 46)}...` : prompt.text;
        promptList.appendChild(b);
      });
      promptList.dataset.enhanced = '1';
    }
  }

  function draftReviewQuestion() {
    draftQuestion(buildReviewCoachPrompt());
  }

  return {
    bindEvents,
    draftQuestion,
    draftReviewQuestion,
    init,
    updateContext,
  };
}
