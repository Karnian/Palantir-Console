'use strict';

// Client apiFetch (server/public/app/lib/api.js) error-shape contract.
//
// holistic-review fix (operator-centric #334~#341): apiFetch used to throw a
// plain Error, dropping HTTP status/body. Views like ProjectsView map warm
// 409/400/502 and repoPreflight reason codes off `err.status` / `err.reason`,
// so those friendly messages were silently dead on the real network path
// (jsdom tests only ever stubbed `err.status` directly). This pins that the
// thrown error preserves status, parsed body, and reason.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const API_URL = pathToFileURL(
  path.join(__dirname, '..', 'public', 'app', 'lib', 'api.js'),
).href;

function stubGlobals(response) {
  const priorFetch = globalThis.fetch;
  const priorLocation = Object.getOwnPropertyDescriptor(globalThis, 'location');
  globalThis.fetch = async () => response;
  // apiFetch only touches location on 401/403; provide a harmless stub.
  globalThis.location = { pathname: '/', search: '', hash: '', replace() {} };
  return () => {
    globalThis.fetch = priorFetch;
    if (priorLocation) Object.defineProperty(globalThis, 'location', priorLocation);
    else delete globalThis.location;
  };
}

function jsonResponse({ status, ok, body }) {
  return { status, ok, json: async () => body };
}

test('apiFetch preserves status, body, and reason on a non-ok JSON response', async () => {
  const restore = stubGlobals(jsonResponse({
    status: 409,
    ok: false,
    body: { error: 'no active top manager', reason: 'no_top' },
  }));
  try {
    const { apiFetch } = await import(API_URL);
    await assert.rejects(
      () => apiFetch('/api/manager/pm/proj/warm', { method: 'POST' }),
      (err) => {
        assert.equal(err.status, 409);
        assert.equal(err.reason, 'no_top');
        assert.deepEqual(err.data, { error: 'no active top manager', reason: 'no_top' });
        assert.match(err.message, /no active top manager/);
        return true;
      },
    );
  } finally {
    restore();
  }
});

test('apiFetch attaches status even when the error body is not JSON', async () => {
  const restore = stubGlobals({
    status: 502,
    ok: false,
    json: async () => { throw new Error('not json'); },
  });
  try {
    const { apiFetch } = await import(API_URL);
    await assert.rejects(
      () => apiFetch('/api/manager/pm/proj/warm', { method: 'POST' }),
      (err) => {
        assert.equal(err.status, 502);
        assert.match(err.message, /Request failed: 502/);
        return true;
      },
    );
  } finally {
    restore();
  }
});

test('apiFetch returns parsed data on a 2xx response', async () => {
  const restore = stubGlobals(jsonResponse({
    status: 200,
    ok: true,
    body: { spawned: true },
  }));
  try {
    const { apiFetch } = await import(API_URL);
    const data = await apiFetch('/api/manager/pm/proj/warm', { method: 'POST' });
    assert.deepEqual(data, { spawned: true });
  } finally {
    restore();
  }
});
