// Toast notification system. Used to be inline in app.js; lifted out as
// part of Phase 4 (B3) so the data hooks could stop reaching at it via
// global identifiers and so it could be tested or mocked in isolation.
//
import { apiFetch } from './api.js';

import { h } from '../../vendor/preact.module.js';
import { useState, useEffect } from '../../vendor/hooks.module.js';
import htm from '../../vendor/htm.module.js';
const html = htm.bind(h);

// Simple pub/sub: addToast pushes a new toast onto the array and notifies
// every subscriber. useToasts subscribes a setState updater so any rendered
// ToastContainer re-renders when the array changes. State is module-scoped
// (not React state) so non-component code can call addToast freely.
const toastState = { toasts: [], listeners: [] };
let toastIdCounter = 0;

// Phase J (2026-04-26): cap the visible stack at 5. Without this, a
// burst of SSE error toasts (e.g. 30+ failures in a flapping connection)
// would pile up and either off-screen or, with the new container max-
// height + overflow-y, swallow keyboard focus inside the toast region.
// New toasts win — when the stack is full the OLDEST entry is dropped
// so the newest signal stays visible. The 5s auto-dismiss timer still
// runs per toast, so a single transient error self-cleans on its own.
const TOAST_STACK_CAP = 5;

export function addToast(message, type = 'error') {
  const id = ++toastIdCounter;
  const next = [...toastState.toasts, { id, message, type }];
  toastState.toasts = next.length > TOAST_STACK_CAP
    ? next.slice(next.length - TOAST_STACK_CAP)
    : next;
  toastState.listeners.forEach(fn => fn(toastState.toasts));
  // Auto-dismiss after 5s
  setTimeout(() => {
    toastState.toasts = toastState.toasts.filter(t => t.id !== id);
    toastState.listeners.forEach(fn => fn(toastState.toasts));
  }, 5000);
}

export function useToasts() {
  const [toasts, setToasts] = useState(toastState.toasts);
  useEffect(() => {
    toastState.listeners.push(setToasts);
    return () => {
      toastState.listeners = toastState.listeners.filter(fn => fn !== setToasts);
    };
  }, []);
  return toasts;
}

export function ToastContainer() {
  const toasts = useToasts();
  if (!toasts.length) return null;
  return html`
    <div class="toast-container" role="status" aria-live="polite">
      ${toasts.map(t => html`
        <div key=${t.id} class="toast toast-${t.type}">
          <span class="toast-message">${t.message}</span>
        </div>
      `)}
    </div>
  `;
}

// Wraps apiFetch to surface errors as toasts. Imported directly from
// ./api.js (no window indirection) so the bundling and import graph stay
// honest.
export async function apiFetchWithToast(url, opts = {}) {
  try {
    return await apiFetch(url, opts);
  } catch (err) {
    addToast(err.message || 'Request failed', 'error');
    throw err;
  }
}
