import { apiFetch } from '../../lib/api.js';

export function ownedApiPath(sessionId) {
  const basePath = '/api/owned-sessions';
  return sessionId ? `${basePath}/${encodeURIComponent(sessionId)}` : basePath;
}

export function ownedRequestKey() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  const randomHex = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
  return `rk_${Date.now()}_${randomHex}`;
}

// Never substitute a truncated preview for an approval input.
export async function ownedFullText(sessionId, source, reference) {
  let offset = 0;
  let text = '';
  for (;;) {
    const query = `source=${source}&ref=${encodeURIComponent(reference)}&offset=${offset}`;
    const result = await apiFetch(`${ownedApiPath(sessionId)}/chunks?${query}`);
    if (result.host !== 'running' || !result.found) throw new Error('host_unreachable');
    text += result.data;
    if (result.done) return text;
    const length = new TextEncoder().encode(result.data).length;
    if (!length) throw new Error('invalid_chunk');
    offset += length;
  }
}
