// Tab-local durable intent. Memory survives route unmounts when storage is unavailable.
const pendingStorageKey = 'palantir.owned.pending.v1';
let pendingMemory = null;
let pendingStorageWarning = '';
const pendingListeners = new Set();
const settledRequestKeys = new Set();

export function subscribeOwnedPending(listener) {
  pendingListeners.add(listener);
  return () => pendingListeners.delete(listener);
}

function notifyOwnedPending() {
  for (const listener of pendingListeners) listener();
}

export function loadOwnedPending() {
  try {
    const stored = sessionStorage.getItem(pendingStorageKey);
    if (stored) {
      const request = JSON.parse(stored);
      const safePath = /^\/api\/owned-sessions\/(?:start|[A-Za-z0-9_-]+(?:\/[a-z-]+)?)$/.test(request.path);
      if (safePath && ['POST', 'DELETE'].includes(request.method)
        && typeof request.body?.request_key === 'string' && !settledRequestKeys.has(request.body.request_key)) {
        pendingMemory = request;
      }
    }
  } catch {
    pendingStorageWarning = 'pendingStorageWarning';
  }
  return { request: pendingMemory, warning: pendingStorageWarning };
}

export function saveOwnedPending(request) {
  pendingMemory = request;
  try {
    sessionStorage.setItem(pendingStorageKey, JSON.stringify(request));
  } catch {
    pendingStorageWarning = 'pendingStorageWarning';
  }
  notifyOwnedPending();
  return pendingStorageWarning;
}

export function clearOwnedPending(requestKey) {
  if (loadOwnedPending().request?.body.request_key !== requestKey) return;
  pendingMemory = null;
  settledRequestKeys.add(requestKey);
  try {
    sessionStorage.removeItem(pendingStorageKey);
  } catch {
    pendingStorageWarning = 'pendingStorageWarning';
  }
  notifyOwnedPending();
}
