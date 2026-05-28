// offline-queue.js
//
// Tiny IndexedDB wrapper for the one thing the user can do meaningfully
// offline: complete drills. When `apiPost(endpoints.drillsResult(), …)`
// fails on a real network outage, drills.js enqueues the payload here.
// On the next `online` event (wired in app.js), `flushDrillResults` posts
// each queued payload, deletes successes, and leaves transient failures
// for the next flush.
//
// Why one store, not a generic queue:
//   - Drills are the only flow that's worth the offline complexity.
//   - A generic "post-once-online" queue surfaces ordering and conflict
//     questions we don't have to answer for one endpoint.
//
// Why IndexedDB and not localStorage:
//   - localStorage is sync and capped at ~5MB; IndexedDB scales to dozens
//     of megabytes per origin and won't block the main thread.
//
// All ops are no-op safe when IndexedDB isn't available (Safari private
// browsing, locked-down kiosks, polyfill-less embeds). The export
// signatures stay stable; the offline path just never triggers.

const DB_NAME = 'cc-offline';
const DB_VERSION = 1;
const STORE = 'drill-results';

function hasIDB() {
  return typeof indexedDB !== 'undefined';
}

function openDb() {
  return new Promise((resolve, reject) => {
    if (!hasIDB()) {
      reject(new Error('indexedDB unavailable'));
      return;
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        // `id` is auto-incrementing so flushDrillResults can iterate in
        // insertion order without us tracking timestamps for ordering.
        db.createObjectStore(STORE, { keyPath: 'id', autoIncrement: true });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function txStore(db, mode) {
  return db.transaction(STORE, mode).objectStore(STORE);
}

async function withDb(fn, fallback) {
  if (!hasIDB()) return fallback;
  let db;
  try {
    db = await openDb();
  } catch (_) {
    return fallback;
  }
  try {
    return await fn(db);
  } finally {
    try {
      db.close();
    } catch (_) {
      // ignore — closing a closed db is a no-op in spec but some shims throw
    }
  }
}

// Public — append a drill result payload. Returns the assigned id, or
// `null` when IndexedDB isn't available.
export async function enqueueDrillResult(payload, endpoint) {
  return withDb(
    (db) =>
      new Promise((resolve, reject) => {
        const store = txStore(db, 'readwrite');
        const req = store.add({
          payload,
          endpoint,
          createdAt: new Date().toISOString(),
        });
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      }),
    null
  );
}

// Public — count of pending records. Used for future UI badges; today
// no surface consumes it but it's part of the documented API.
export async function pendingDrillCount() {
  return withDb(
    (db) =>
      new Promise((resolve) => {
        const store = txStore(db, 'readonly');
        const req = store.count();
        req.onsuccess = () => resolve(req.result || 0);
        req.onerror = () => resolve(0);
      }),
    0
  );
}

async function readAllRecords(db) {
  return new Promise((resolve, reject) => {
    const store = txStore(db, 'readonly');
    const req = store.getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}

async function deleteById(db, id) {
  return new Promise((resolve, reject) => {
    const store = txStore(db, 'readwrite');
    const req = store.delete(id);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

// Public — post each queued record. Successes are deleted; transient
// failures (network errors) stay queued for next time. Auth/HTTP errors
// from a posted record are also dropped from the queue — keeping a 401'd
// drill result around forever helps no one — but counted as `failed`.
//
// Returns { flushed, remaining, failed }.
export async function flushDrillResults(apiPost) {
  return withDb(
    async (db) => {
      const records = await readAllRecords(db);
      let flushed = 0;
      let failed = 0;
      for (const rec of records) {
        try {
          await apiPost(rec.endpoint, rec.payload);
          await deleteById(db, rec.id);
          flushed += 1;
        } catch (err) {
          if (isTransientNetworkError(err)) {
            // Still offline / server unreachable — leave it for next flush.
            continue;
          }
          // Permanent error: drop the record so we don't loop forever, but
          // count it so the caller can toast something useful.
          await deleteById(db, rec.id).catch(() => {});
          failed += 1;
        }
      }
      const remaining = await new Promise((resolve) => {
        const store = txStore(db, 'readonly');
        const req = store.count();
        req.onsuccess = () => resolve(req.result || 0);
        req.onerror = () => resolve(0);
      });
      return { flushed, remaining, failed };
    },
    { flushed: 0, remaining: 0, failed: 0 }
  );
}

// Public — used by drills.js to decide whether to enqueue. fetch() throws
// a TypeError when there's no network; the api.js wrapper surfaces HTTP
// errors as Errors with a `.status` property. We only want to enqueue
// the no-network case — auth/validation errors should surface immediately.
export function isTransientNetworkError(err) {
  if (!err) return false;
  // navigator.onLine is the cheapest signal — covers most cases.
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    return true;
  }
  // fetch's network-down error is a TypeError without a .status.
  if (err instanceof TypeError && !('status' in err)) return true;
  // Defensive: if our api wrapper preserves a "network" tag, honor it.
  if (err.name === 'NetworkError' || err.name === 'TimeoutError') return true;
  return false;
}
