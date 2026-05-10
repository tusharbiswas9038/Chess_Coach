const stores = new Map();

function nowMs() {
  return Date.now();
}

export function createCache(namespace = 'default') {
  if (!stores.has(namespace)) {
    stores.set(namespace, new Map());
  }
  const store = stores.get(namespace);

  function get(key) {
    const entry = store.get(key);
    if (!entry) return null;
    if (entry.expiresAt <= nowMs()) {
      store.delete(key);
      return null;
    }
    return entry.value;
  }

  function set(key, value, ttlMs = 30000) {
    store.set(key, {
      value,
      expiresAt: nowMs() + Math.max(0, Number(ttlMs) || 0),
    });
    return value;
  }

  async function getOrSet(key, loader, ttlMs = 30000) {
    const cached = get(key);
    if (cached !== null) return cached;
    const value = await loader();
    set(key, value, ttlMs);
    return value;
  }

  function del(key) {
    store.delete(key);
  }

  function clear() {
    store.clear();
  }

  return {
    clear,
    del,
    get,
    getOrSet,
    set,
  };
}

