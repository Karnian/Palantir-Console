import { OWNED_COPY } from '../../lib/copy.js';

export function ownedLabel(value) {
  return OWNED_COPY[value] || OWNED_COPY.unknown;
}

export function parseOwnedJson(value) {
  try {
    return typeof value === 'string' ? JSON.parse(value) : value;
  } catch {
    return null;
  }
}

export function formatOwnedTime(value) {
  if (!value) return OWNED_COPY.noTime;
  return new Date(value).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' });
}
