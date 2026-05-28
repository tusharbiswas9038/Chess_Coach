// PWA install-prompt orchestration.
//
// Browsers fire `beforeinstallprompt` once when the page becomes installable
// — we have to capture and stash the event, then call `.prompt()` later in
// response to a user gesture. We only surface the chip after the user has
// shown sustained interest (3 distinct sessions, where a "session" is any
// page load on a different calendar day).
//
// Behavior:
// - Counts unique calendar days the page has loaded; persists in localStorage.
// - Captures `beforeinstallprompt` and saves the deferred prompt.
// - Reveals `#btn-install-app` once both conditions are met.
// - On click, calls `.prompt()`, hides the chip, and remembers the outcome
//   so we don't pester users who declined.
//
// Failure modes are quiet: localStorage off → no count, no chip;
// non-supporting browser (Safari) → no event, no chip; user declined →
// chip hides for the rest of the session and we set a flag to skip future
// prompts unless they clear storage.

const SESSIONS_KEY = 'cc.pwa.sessions';
const LAST_DAY_KEY = 'cc.pwa.lastDay';
const DECLINED_KEY = 'cc.pwa.declined';
const SESSION_THRESHOLD = 3;

let deferredPrompt = null;

function readSessionCount() {
  try {
    return Math.max(0, parseInt(window.localStorage.getItem(SESSIONS_KEY) || '0', 10));
  } catch (_) {
    return 0;
  }
}

function writeSessionCount(n) {
  try {
    window.localStorage.setItem(SESSIONS_KEY, String(n));
  } catch (_) {
    // localStorage off — accept that the count won't increment
  }
}

function todayStamp() {
  return new Date().toISOString().slice(0, 10);
}

function userDeclined() {
  try {
    return window.localStorage.getItem(DECLINED_KEY) === '1';
  } catch (_) {
    return false;
  }
}

function markDeclined() {
  try {
    window.localStorage.setItem(DECLINED_KEY, '1');
  } catch (_) {
    // ignore
  }
}

// Increment the calendar-day counter exactly once per UTC day. We count
// days, not raw page loads, because dev refreshes shouldn't accelerate
// the prompt. A user has to come back tomorrow before the count moves.
function bumpSessionCountIfNewDay() {
  try {
    const today = todayStamp();
    const last = window.localStorage.getItem(LAST_DAY_KEY);
    if (last === today) return readSessionCount();
    const next = readSessionCount() + 1;
    window.localStorage.setItem(LAST_DAY_KEY, today);
    writeSessionCount(next);
    return next;
  } catch (_) {
    return readSessionCount();
  }
}

function chipEl() {
  return document.getElementById('btn-install-app');
}

function maybeShowChip() {
  if (!deferredPrompt) return;
  if (userDeclined()) return;
  const sessions = readSessionCount();
  if (sessions < SESSION_THRESHOLD) return;
  const el = chipEl();
  if (!el) return;
  el.hidden = false;
}

async function onInstallClick() {
  if (!deferredPrompt) return;
  const el = chipEl();
  if (el) el.disabled = true;
  try {
    await deferredPrompt.prompt();
    const choice = await deferredPrompt.userChoice;
    if (choice?.outcome === 'dismissed') {
      // User said no — don't show the chip again. They can clear site data
      // to reset, but we don't want to nag.
      markDeclined();
    }
  } catch (_) {
    // ignore — browser may have rejected the prompt
  } finally {
    deferredPrompt = null;
    if (el) {
      el.disabled = false;
      el.hidden = true;
    }
  }
}

export function setupInstallPrompt() {
  bumpSessionCountIfNewDay();

  window.addEventListener('beforeinstallprompt', (event) => {
    event.preventDefault();
    deferredPrompt = event;
    maybeShowChip();
  });

  window.addEventListener('appinstalled', () => {
    deferredPrompt = null;
    const el = chipEl();
    if (el) el.hidden = true;
  });

  const el = chipEl();
  if (el) el.addEventListener('click', onInstallClick);

  // Try to show on next tick in case beforeinstallprompt already fired
  // before this module loaded (it's queued, but the chip might not have
  // been in the DOM yet on really fast browsers).
  setTimeout(maybeShowChip, 0);
}

// Test/debug helper. Not wired to any UI; call from devtools to clear.
export function resetInstallPromptState() {
  try {
    window.localStorage.removeItem(SESSIONS_KEY);
    window.localStorage.removeItem(LAST_DAY_KEY);
    window.localStorage.removeItem(DECLINED_KEY);
  } catch (_) {
    // ignore
  }
}
