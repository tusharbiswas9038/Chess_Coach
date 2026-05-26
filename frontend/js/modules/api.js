const API = '';

async function parseError(response) {
  try {
    const payload = await response.json();
    return payload?.detail || `${response.status} ${response.statusText}`;
  } catch {
    return `${response.status} ${response.statusText}`;
  }
}

async function assertOk(response) {
  if (response.ok) return;
  if (response.status === 401 || response.status === 403) {
    window.dispatchEvent(new CustomEvent('app:auth-required'));
  }
  throw new Error(await parseError(response));
}

export async function api(path) {
  const r = await fetch(API + path, { credentials: 'same-origin' });
  await assertOk(r);
  return r.json();
}

export async function apiContract(path, normalizer, label = 'response') {
  const payload = await api(path);
  try {
    return normalizer(payload);
  } catch (e) {
    throw new Error(`${label}: ${e.message}`);
  }
}

export async function apiPost(path, body = {}) {
  const headers = { 'Content-Type': 'application/json' };
  const r = await fetch(API + path, {
    method: 'POST',
    headers,
    credentials: 'same-origin',
    body: JSON.stringify(body),
  });
  await assertOk(r);
  return r.json();
}
