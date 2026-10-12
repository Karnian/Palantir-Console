// Shared by manager and assistant requests, including remote HTTP without randomUUID.
export function createClientMessageKey() {
  return globalThis.crypto && typeof globalThis.crypto.randomUUID === 'function'
    ? globalThis.crypto.randomUUID()
    : `msg_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}
