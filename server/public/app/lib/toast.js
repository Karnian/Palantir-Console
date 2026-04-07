// Toast notification system. Used to be inline in app.js; lifted out as
// part of Phase 4 (B3) so the data hooks could stop reaching at it via
// global identifiers and so it could be tested or mocked in isolation.
//
// Module-time dependencies (preact hooks, htm) are resolved off `window`,
// so this file MUST be loaded AFTER main.js has assigned the bridges.
// main.js handles that ordering by dynamic-importing this module.

import { apiFetch } from './api.js';

const { useState, useEffect } = window.preactHooks;
const { h } = window.preact;
const html = window.htm.bind(h);

// Simple pub/sub: addToast pushes a new toast onto the array and notifies
// every subscriber. useToasts subscribes a setState updater so any rendered
// ToastContainer re-renders when the array changes. State is module-scoped
// (not React state) so non-component code can call addToast freely.
const toastState = { toasts: [], listeners: [] };
let toastIdCounter = 0;

export function addToast(message, type = 'error') {
  const id = ++toastIdCounter;
  toastState.toasts = [...toastState.toasts, { id, message, type }];
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
