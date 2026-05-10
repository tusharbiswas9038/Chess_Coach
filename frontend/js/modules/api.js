const API = '';

export async function api(path) {
  const r = await fetch(API + path);
  if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
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
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
  return r.json();
}
