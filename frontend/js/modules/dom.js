export function createDomCache(root = document) {
  const byIdCache = new Map();

  function byId(id) {
    if (!byIdCache.has(id)) {
      byIdCache.set(id, root.getElementById(id));
    }
    return byIdCache.get(id);
  }

  function query(selector) {
    return root.querySelector(selector);
  }

  function queryAll(selector) {
    return root.querySelectorAll(selector);
  }

  return {
    byId,
    query,
    queryAll,
  };
}
