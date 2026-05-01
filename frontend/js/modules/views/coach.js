import { esc } from '../ui.js';
import { createDomCache } from '../dom.js';

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
      <div class="coach-empty">
        <div class="coach-empty-icon">♟</div>
        <div class="coach-empty-title">No coach conversation yet</div>
        <div class="coach-empty-copy">
          Pick a prompt or ask a direct question. The coach will use your current chess data as context.
        </div>
      </div>
    `;
      return;
    }

    container.innerHTML =
      coachHistory
        .map(
          (message) => `
          <div class="coach-message coach-message-${message.role}">
            <div class="coach-bubble">${esc(message.content)}</div>
          </div>
        `
        )
        .join('') +
      (pending
        ? `
          <div class="coach-message coach-message-assistant coach-message-pending">
            <div class="coach-bubble">Coach is thinking…</div>
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
    input.value = text;
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
      const result = await apiPost('/api/coach/chat', {
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
        content: `I could not reach the coach model. ${e.message}`,
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
