import { endpoints } from './contracts.js';


export function createAuthGate({ api, apiPost, toast }) {
  let session = { authenticated: false, auth_required: false };

  function renderLogin() {
    let overlay = document.getElementById('auth-gate');
    if (!overlay) {
      overlay = document.createElement('div');
      overlay.id = 'auth-gate';
      overlay.className =
        'fixed inset-0 z-[3000] flex items-center justify-center bg-[rgba(15,17,23,0.92)] px-4 backdrop-blur-xl';
      overlay.innerHTML = `
        <form id="auth-form" class="w-full max-w-[420px] rounded-[24px] border border-[rgba(255,255,255,0.08)] bg-[linear-gradient(135deg,rgba(22,27,34,0.98),rgba(15,17,23,0.98))] p-6 shadow-[0_24px_80px_rgba(0,0,0,0.45)]">
          <div class="mb-5">
            <div class="mb-2 inline-flex rounded-full border border-[rgba(63,185,80,0.25)] bg-[rgba(63,185,80,0.08)] px-3 py-1 text-xs font-semibold uppercase tracking-[0.16em] text-[var(--primary)]">Private workspace</div>
            <h1 class="text-2xl font-bold tracking-[-0.03em] text-[var(--text)]">Sign in to Chess Coach</h1>
            <p class="mt-2 text-sm leading-relaxed text-[var(--muted)]">Use your configured admin account. The session is stored in a secure HTTP-only cookie.</p>
          </div>
          <label class="mb-3 block">
            <span class="mb-1 block text-xs font-semibold uppercase tracking-[0.12em] text-[var(--muted)]">Username</span>
            <input id="auth-username" class="field-input w-full" autocomplete="username" value="admin" required />
          </label>
          <label class="mb-4 block">
            <span class="mb-1 block text-xs font-semibold uppercase tracking-[0.12em] text-[var(--muted)]">Password</span>
            <input id="auth-password" class="field-input w-full" type="password" autocomplete="current-password" required />
          </label>
          <button id="auth-submit" class="btn btn-primary w-full justify-center" type="submit">Sign in</button>
          <p id="auth-error" class="mt-3 min-h-5 text-sm text-[var(--error)]" role="alert"></p>
        </form>
      `;
      document.body.appendChild(overlay);
      overlay.querySelector('#auth-form')?.addEventListener('submit', submitLogin);
    }
    overlay.hidden = false;
    overlay.querySelector('#auth-password')?.focus();
  }

  function hideLogin() {
    const overlay = document.getElementById('auth-gate');
    if (overlay) overlay.hidden = true;
  }

  async function submitLogin(event) {
    event.preventDefault();
    const form = event.currentTarget;
    const submit = form.querySelector('#auth-submit');
    const error = form.querySelector('#auth-error');
    const username = form.querySelector('#auth-username')?.value?.trim() || '';
    const password = form.querySelector('#auth-password')?.value || '';
    if (error) error.textContent = '';
    if (submit) {
      submit.disabled = true;
      submit.textContent = 'Signing in...';
    }
    try {
      await apiPost(endpoints.authLogin(), { username, password });
      session = await api(endpoints.authSession());
      hideLogin();
      toast?.('Signed in.');
      window.dispatchEvent(new CustomEvent('app:auth-changed', { detail: session }));
    } catch (e) {
      if (error) error.textContent = e.message || 'Sign in failed.';
    } finally {
      if (submit) {
        submit.disabled = false;
        submit.textContent = 'Sign in';
      }
    }
  }

  async function init() {
    try {
      session = await api(endpoints.authSession());
    } catch {
      session = { authenticated: false, auth_required: false };
    }
    if (session.auth_required && !session.authenticated) {
      renderLogin();
    } else {
      hideLogin();
    }
    return session;
  }

  async function requireLogin() {
    await init();
    if (session.auth_required && !session.authenticated) {
      renderLogin();
    }
  }

  async function logout() {
    await apiPost(endpoints.authLogout(), {});
    session = await api(endpoints.authSession());
    renderLogin();
    toast?.('Signed out.');
    window.dispatchEvent(new CustomEvent('app:auth-changed', { detail: session }));
  }

  function getSession() {
    return session;
  }

  return {
    getSession,
    init,
    logout,
    requireLogin,
  };
}
