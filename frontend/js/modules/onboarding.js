import { endpoints } from './contracts.js';

const STORAGE_KEY = 'cc.onboarding.dismissed';
const MODAL_ID = 'cc-onboarding-modal';

function alreadyDismissed() {
  try {
    return window.localStorage.getItem(STORAGE_KEY) === '1';
  } catch (_) {
    return false;
  }
}

function persistDismissed() {
  try {
    window.localStorage.setItem(STORAGE_KEY, '1');
  } catch (_) {
    // ignore
  }
}

function buildMarkup({ username, totalGames }) {
  const display = username || 'your Chess.com account';
  const empty = !totalGames;
  return `
    <div id="${MODAL_ID}" class="onboarding-modal fixed inset-0 z-[200] flex items-center justify-center bg-[rgba(8,11,15,0.7)] p-4 backdrop-blur-sm" role="dialog" aria-modal="true" aria-labelledby="onboarding-title">
      <div class="onboarding-card w-full max-w-[520px] rounded-cc-lg border border-[var(--border)] bg-[var(--surface)] p-6 shadow-cc-md">
        <div class="mb-3 inline-flex rounded-full border border-[rgba(63,185,80,0.25)] bg-[rgba(63,185,80,0.08)] px-3 py-1 text-xs font-semibold uppercase tracking-[0.16em] text-[var(--primary)]">
          Welcome
        </div>
        <h2 id="onboarding-title" class="text-2xl font-bold tracking-[-0.02em] text-[var(--text)]">
          Let’s set up your coaching workspace
        </h2>
        <p class="mt-2 text-sm leading-relaxed text-[var(--muted)]">
          Chess Coach pulls your rapid games from <strong class="text-[var(--text)]">${display}</strong>,
          analyzes them with Stockfish, and turns recurring mistakes into a daily drill queue.
          ${empty ? 'Your first sync usually pulls 50–500 games and takes a few minutes.' : 'Your data is already in place — keep going.'}
        </p>

        <ol class="onboarding-steps mt-4 grid gap-2 text-sm">
          <li class="flex items-start gap-3 rounded-cc border border-[var(--border)] bg-[var(--surface-2)] p-3">
            <span class="onboarding-step-num inline-grid h-7 w-7 place-items-center rounded-full bg-[rgba(63,185,80,0.15)] text-[13px] font-semibold text-[var(--primary)]">1</span>
            <div>
              <div class="font-semibold text-[var(--text)]">Sync your games</div>
              <div class="text-[var(--muted)]">Imports recent rapid games from Chess.com. Re-running it later only fetches new ones.</div>
            </div>
          </li>
          <li class="flex items-start gap-3 rounded-cc border border-[var(--border)] bg-[var(--surface-2)] p-3">
            <span class="onboarding-step-num inline-grid h-7 w-7 place-items-center rounded-full bg-[rgba(88,166,255,0.15)] text-[13px] font-semibold text-[var(--secondary)]">2</span>
            <div>
              <div class="font-semibold text-[var(--text)]">Analyze the queue</div>
              <div class="text-[var(--muted)]">Stockfish runs at depth 18 to classify mistakes and find the critical move per game.</div>
            </div>
          </li>
          <li class="flex items-start gap-3 rounded-cc border border-[var(--border)] bg-[var(--surface-2)] p-3">
            <span class="onboarding-step-num inline-grid h-7 w-7 place-items-center rounded-full bg-[rgba(168,85,247,0.18)] text-[13px] font-semibold text-[var(--analytics)]">3</span>
            <div>
              <div class="font-semibold text-[var(--text)]">Train and review</div>
              <div class="text-[var(--muted)]">Drills come from your real mistakes. The coach reads your data — ask about openings, time pressure, or specific games.</div>
            </div>
          </li>
        </ol>

        <div id="onboarding-status" class="mt-3 min-h-5 text-sm text-[var(--muted)]" role="status" aria-live="polite"></div>

        <div class="onboarding-actions mt-4 flex flex-wrap items-center justify-end gap-2">
          <button id="onboarding-skip" class="btn btn-ghost" type="button">
            I’ll explore on my own
          </button>
          <button id="onboarding-start" class="btn btn-primary" type="button" ${empty ? '' : 'data-mode="dismiss"'}>
            ${empty ? 'Start first sync' : 'Got it'}
          </button>
        </div>
      </div>
    </div>
  `;
}

export function maybeShowOnboarding({ statsData, apiPost, toast }) {
  if (!statsData || alreadyDismissed()) return;
  const totalGames = Number(statsData?.games?.total) || 0;
  // Already-onboarded users with data shouldn't see this — bail and persist.
  if (totalGames > 0) {
    persistDismissed();
    return;
  }
  if (document.getElementById(MODAL_ID)) return;

  const profile = statsData?.profile || {};
  const username = profile.username || '';

  const wrap = document.createElement('div');
  wrap.innerHTML = buildMarkup({ username, totalGames });
  document.body.appendChild(wrap.firstElementChild);

  const modal = document.getElementById(MODAL_ID);
  const skip = modal.querySelector('#onboarding-skip');
  const start = modal.querySelector('#onboarding-start');
  const status = modal.querySelector('#onboarding-status');

  function close({ persist = true } = {}) {
    if (persist) persistDismissed();
    modal.remove();
  }

  skip.addEventListener('click', () => close({ persist: true }));

  start.addEventListener('click', async () => {
    if (start.dataset.mode === 'dismiss') {
      close({ persist: true });
      return;
    }
    start.disabled = true;
    skip.disabled = true;
    status.textContent = 'Queuing sync job…';
    try {
      await apiPost(endpoints.jobSync(), {});
      status.textContent = 'Sync queued. You can close this window — progress shows in the top bar.';
      start.textContent = 'Close';
      start.disabled = false;
      start.dataset.mode = 'dismiss';
      skip.disabled = false;
    } catch (e) {
      status.textContent = 'Could not start sync: ' + e.message;
      toast('Sync failed: ' + e.message);
      start.disabled = false;
      skip.disabled = false;
    }
  });

  modal.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') close({ persist: false });
    if (event.key === 'Tab') {
      const focusable = modal.querySelectorAll(
        'a[href], button:not([disabled]), textarea, input, select, [tabindex]:not([tabindex="-1"])'
      );
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }
  });

  // Trap focus minimally — give Start the initial focus
  start.focus();
}

export function resetOnboarding() {
  try {
    window.localStorage.removeItem(STORAGE_KEY);
  } catch (_) {
    // ignore
  }
}
