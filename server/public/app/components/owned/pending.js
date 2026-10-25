// Only unresolved human requests are persisted, scoped to their target session.
const pendingStorageKey = 'palantir.owned.pending.v1';
let pendingMemory = { requests: {} };
let pendingStorageWarning = '';
let pendingMemoryDirty = false;
const pendingListeners = new Set();
const settledRequestKeys = new Set();
const deletedTargets = new Set();

export function ownedRequestTarget(path) {
  return path.split('/')[3] || 'start';
}

export function subscribeOwnedPending(listener) {
  pendingListeners.add(listener);
  return () => pendingListeners.delete(listener);
}

function readOwnedStore() {
  if (pendingMemoryDirty) return pendingMemory;
  try {
    const text = sessionStorage.getItem(pendingStorageKey);
    if (text) {
      const stored = JSON.parse(text);
      if (stored.path && stored.body?.request_key) {
        const target = stored.session_id || ownedRequestTarget(stored.path);
        stored.session_id = target;
        pendingMemory = { requests: { [target]: stored } };
      } else if (stored.version >= 2 && stored.requests) {
        pendingMemory = { requests: stored.requests };
      }
      for (const [target, request] of Object.entries(pendingMemory.requests)) {
        const safePath = /^\/api\/owned-sessions\/(?:start|[A-Za-z0-9_-]+(?:\/[a-z-]+)?)$/.test(request?.path);
        const valid = safePath && ownedRequestTarget(request.path) === target
          && ['POST', 'DELETE'].includes(request.method) && typeof request.body?.request_key === 'string'
          && !['__proto__', 'constructor', 'prototype'].includes(target);
        if (!valid || deletedTargets.has(target) || settledRequestKeys.has(request.body.request_key)) delete pendingMemory.requests[target];
      }
      // Canonicalize older documents; discard every obsolete non-request field and its text.
      if (stored.version !== 3 || Object.keys(stored).some(key => !['version', 'requests'].includes(key))) {
        sessionStorage.setItem(pendingStorageKey, JSON.stringify({ version: 3, requests: pendingMemory.requests }));
      }
    }
  } catch {
    pendingStorageWarning = 'pendingStorageWarning';
  }
  return pendingMemory;
}

function writeOwnedStore(store) {
  pendingMemory = store;
  let persisted = true;
  try {
    sessionStorage.setItem(pendingStorageKey, JSON.stringify({ version: 3, requests: store.requests }));
    pendingMemoryDirty = false;
  } catch {
    pendingStorageWarning = 'pendingStorageWarning';
    persisted = false;
    pendingMemoryDirty = true;
  }
  for (const listener of pendingListeners) listener();
  return persisted;
}

export function loadOwnedPending(target) {
  const store = readOwnedStore();
  const requests = Object.values(store.requests);
  return {
    request: target === undefined ? requests[0] || null
      : Object.hasOwn(store.requests, target) ? store.requests[target] : null,
    others: requests.filter(request => request.session_id !== target),
    warning: pendingStorageWarning
  };
}

export function saveOwnedPending(request) {
  const store = readOwnedStore();
  const target = request.session_id || ownedRequestTarget(request.path);
  if (deletedTargets.has(target)) return pendingStorageWarning;
  store.requests[target] = { ...request, session_id: target };
  writeOwnedStore(store);
  return pendingStorageWarning;
}

export function clearOwnedPending(requestKey) {
  const store = readOwnedStore();
  for (const [target, request] of Object.entries(store.requests)) {
    if (request.body.request_key !== requestKey) continue;
    delete store.requests[target];
    settledRequestKeys.add(requestKey);
  }
  writeOwnedStore(store);
}

export function clearOwnedPendingTarget(target) {
  const store = readOwnedStore();
  deletedTargets.add(target);
  const request = store.requests[target];
  if (request) settledRequestKeys.add(request.body.request_key);
  delete store.requests[target];
  writeOwnedStore(store);
}
