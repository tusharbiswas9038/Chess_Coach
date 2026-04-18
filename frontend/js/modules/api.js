const API = '';

export async function api(path) {
  const r = await fetch(API + path);
  if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
  return r.json();
}

export async function apiPost(path, body = {}) {
  const r = await fetch(API + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
  return r.json();
}
