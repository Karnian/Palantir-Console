// One tab-local document stores requests and composite intents by target session.
const pendingStorageKey = 'palantir.owned.pending.v1';
let pendingMemory = { requests: {}, followUps: {} };
let pendingStorageWarning = '';
let pendingMemoryDirty = false;
const pendingListeners = new Set();
const settledRequestKeys = new Set();

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
        pendingMemory = { requests: { [target]: stored }, followUps: {} };
      } else if (stored.version === 2 && stored.requests && stored.followUps) {
        pendingMemory = stored;
      }
      for (const [target, request] of Object.entries(pendingMemory.requests)) {
        const safePath = /^\/api\/owned-sessions\/(?:start|[A-Za-z0-9_-]+(?:\/[a-z-]+)?)$/.test(request?.path);
        const valid = safePath && ownedRequestTarget(request.path) === target
          && ['POST', 'DELETE'].includes(request.method) && typeof request.body?.request_key === 'string'
          && !['__proto__', 'constructor', 'prototype'].includes(target);
        if (!valid || settledRequestKeys.has(request.body.request_key)) delete pendingMemory.requests[target];
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
    sessionStorage.setItem(pendingStorageKey, JSON.stringify({ ...store, version: 2 }));
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
    followUp: target !== undefined && Object.hasOwn(store.followUps, target) ? store.followUps[target] : null,
    warning: pendingStorageWarning
  };
}

export function saveOwnedPending(request) {
  const store = readOwnedStore();
  const target = request.session_id || ownedRequestTarget(request.path);
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

export function saveOwnedFollowUp(target, followUp) {
  const store = readOwnedStore();
  store.followUps[target] = followUp;
  writeOwnedStore(store);
  return pendingStorageWarning;
}

// Consume and reserve the next request in the same storage write before any effect.
export function claimOwnedFollowUp(target, sourceKey, request, manual = false) {
  const store = readOwnedStore();
  const followUp = store.followUps[target];
  if (!followUp || followUp.key !== sourceKey) return false;
  if (followUp.status !== 'waiting' && !(manual && followUp.status === 'held')) return false;
  store.followUps[target] = { ...followUp, status: 'consumed', consumedKey: request.body.request_key };
  store.requests[target] = { ...request, session_id: target };
  return writeOwnedStore(store);
}
