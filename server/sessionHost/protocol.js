'use strict';
const { createHash, timingSafeEqual } = require('node:crypto');
const digest = value => createHash('sha256').update(typeof value === 'string' ? value : '').digest();

function createProtocol({ stream, core, capability, hostBootId, sdkVersion = null, maxLineBytes = 1048576, onActivity = () => {},
  isFatal = () => false }) {
  let buffer = Buffer.alloc(0);
  let authenticated = false;
  let draining = false;
  let closed = false;
  const pending = new Set();
  const send = message => {
    if (!closed && !stream.destroyed) stream.write(JSON.stringify(message) + '\n');
  };
  const close = () => { closed = true; stream.end(() => stream.destroy()); };
  async function handle(message) {
    if (!message || typeof message !== 'object' || Array.isArray(message)) return close();
    if (!authenticated) {
      if (message.type !== 'hello' || !timingSafeEqual(digest(message.capability), digest(capability))) return close();
      authenticated = true;
      send({ type: 'hello', host_boot_id: hostBootId, schema_version: 3, sdk_version: sdkVersion });
      return;
    }
    if (isFatal()) {
      send({ type: 'error', id: message.id, code: 'host_fatal' });
      return;
    }
    if (draining) {
      send({ type: 'not_accepted', id: message.id });
      return close();
    }
    if (!['submit', 'lookup', 'snapshot', 'events_since', 'list', 'settings_preview', 'chunk'].includes(message.type) ||
        !['string', 'number'].includes(typeof message.id)) return close();
    const token = { id: message.id };
    pending.add(token);
    onActivity();
    try {
      let result;
      let receipt;
      if (message.type === 'submit') {
        if (!message.request || typeof message.request !== 'object') throw new Error('invalid_request');
        receipt = await core.submitWithReceipt(message.request);
        result = receipt.result;
      } else if (message.type === 'lookup') result = await core.lookup(message.request_key);
      else if (message.type === 'snapshot') result = await core.snapshot(message.session_id);
      else if (message.type === 'list') result = await core.listSessions();
      else if (message.type === 'settings_preview') result = await core.settingsPreview(message.cwd);
      else if (message.type === 'chunk') result = await core.chunk(message.session_id, message.source, message.id_or_seq, message.offset);
      else result = await core.eventsSince(message.seq, { maxBytes: message.max_bytes });
      if (pending.has(token) && receipt && !receipt.durable) {
        send({ type: 'rejected', id: message.id, request_key: message.request.request_key, code: receipt.code });
      } else if (pending.has(token)) {
        send({ type: message.type === 'submit' ? 'accepted' : message.type, id: message.id,
          ...(message.type === 'submit' ? { request_key: message.request.request_key } : {}), result });
      }
    } catch (error) {
      if (pending.has(token)) send({ type: 'error', id: message.id,
        code: ['invalid_request', 'invalid_chunk', 'invalid_offset'].includes(error.message) ? error.message : 'storage_unavailable' });
    } finally {
      pending.delete(token);
      onActivity();
    }
  }
  stream.on('data', chunk => {
    if (closed) return;
    buffer = Buffer.concat([buffer, Buffer.from(chunk)]);
    let end;
    while ((end = buffer.indexOf(10)) !== -1) {
      if (end > maxLineBytes) return close();
      const line = buffer.subarray(0, end);
      buffer = buffer.subarray(end + 1);
      let message;
      try { message = JSON.parse(line.toString('utf8')); } catch { return close(); }
      void handle(message);
      if (closed) return;
    }
    if (buffer.length > maxLineBytes) close();
  });
  stream.on('error', () => { closed = true; });
  stream.on('close', () => { closed = true; });
  return {
    get pendingCount() { return pending.size; },
    beginDrain() { draining = true; },
    drain() {
      draining = true;
      for (const token of pending) send({ type: 'not_accepted', id: token.id });
      pending.clear();
      close();
    }
  };
}
module.exports = { createProtocol };
