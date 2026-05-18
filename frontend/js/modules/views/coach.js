import { emptyStateMarkup, esc } from '../ui.js';
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
    'Build me a 7-day improvement plan using my current weaknesses.',
    'Give me opening prep priorities for my next rapid session.',
    'I just lost two games. Give me a 10-minute reset routine before I play again.',
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
          ${emptyStateMarkup('No coach conversation yet', '♟', false)}
          <div class="coach-empty-copy text-sm text-[var(--muted)]">
            Pick a prompt or ask a direct question. The coach will use your current chess data as context.
          </div>
        </div>
      `;
      return;
    }

    container.innerHTML =
      coachHistory
        .map(
          (message) => {
            const role = message?.role === 'user' ? 'user' : 'assistant';
            return `
          <div class="coach-message coach-message-${role} mb-3 flex ${role === 'user' ? 'justify-end' : 'justify-start'}">
            <div class="coach-bubble max-w-[92%] rounded-cc border border-[var(--border)] bg-[var(--surface-2)] px-3 py-2 text-sm leading-relaxed">${esc(message.content)}</div>
          </div>
        `
          }
        )
        .join('') +
      (pending
        ? `
          <div class="coach-message coach-message-assistant coach-message-pending mb-3 flex justify-start">
            <div class="coach-bubble max-w-[92%] rounded-cc border border-[var(--border)] bg-[var(--surface-2)] px-3 py-2 text-sm">Coach is thinking…</div>
          </div>
        `
        : '');
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

  function draftQuestion(text) {
    showView('coach');
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
      });
      coachHistory.push({
        role: 'assistant',
        content: result.reply || 'No reply returned.',
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
    dom.query('.coach-prompt-list')?.addEventListener('click', (event) => {
      const btn = event.target.closest('[data-coach-prompt]');
      if (!btn) return;
      draftQuestion(btn.dataset.coachPrompt);
    });
    const promptList = dom.query('.coach-prompt-list');
    if (promptList && !promptList.dataset.enhanced) {
      EXTRA_PROMPTS.forEach((prompt) => {
        const b = document.createElement('button');
        b.className = 'coach-prompt btn btn-ghost w-full justify-start';
        b.type = 'button';
        b.dataset.coachPrompt = prompt;
        b.textContent = prompt.length > 46 ? `${prompt.slice(0, 46)}...` : prompt;
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
