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
  const seen = { fetchOpts: [], redirects: [] };
  globalThis.fetch = async (url, opts) => { seen.fetchOpts.push(opts); return response; };
  // apiFetch only touches location on 401/403; record the bounce so tests can
  // assert an app-level 403 does NOT navigate away.
  globalThis.location = {
    pathname: '/', search: '', hash: '',
    replace(target) { seen.redirects.push(target); },
  };
  const restore = () => {
    globalThis.fetch = priorFetch;
    if (priorLocation) Object.defineProperty(globalThis, 'location', priorLocation);
    else delete globalThis.location;
  };
  restore.seen = seen;
  return restore;
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

// task_85d43f96 — /api/fs answers 403 for application-level path denials
// (outside exposed_roots, permission denied). Bouncing the operator to
// /login.html for a mistyped path would be nonsense, and the directory
// picker's node-change reset keys off exactly those two reasons — so it must
// receive them as errors, not as a navigation. The discriminator is `reason`,
// which an auth rejection can never carry (auth fails before any route runs).

test('apiFetch with allowAppForbidden surfaces a 403 that carries a reason instead of bouncing', async () => {
  const restore = stubGlobals(jsonResponse({
    status: 403,
    ok: false,
    body: { error: 'Path not allowed', reason: 'path_outside_root' },
  }));
  try {
    const { apiFetch } = await import(API_URL);
    await assert.rejects(
      () => apiFetch('/api/fs?path=%2Fetc&nodeId=pod-a', { allowAppForbidden: true }),
      (err) => {
        assert.equal(err.status, 403);
        assert.equal(err.reason, 'path_outside_root');
        assert.match(err.message, /Path not allowed/);
        return true;
      },
    );
    assert.deepEqual(restore.seen.redirects, [], 'an app-level 403 must not navigate to login');
  } finally {
    restore();
  }
});

test('apiFetch with allowAppForbidden still bounces a 403 with no reason (real auth failure)', async () => {
  const restore = stubGlobals(jsonResponse({
    status: 403,
    ok: false,
    body: { error: 'Authentication required' },
  }));
  try {
    const { apiFetch } = await import(API_URL);
    await assert.rejects(
      () => apiFetch('/api/fs', { allowAppForbidden: true }),
      (err) => {
        assert.match(err.message, /Not authenticated/);
        return true;
      },
    );
    assert.equal(restore.seen.redirects.length, 1);
    assert.match(restore.seen.redirects[0], /^\/login\.html\?next=/);
  } finally {
    restore();
  }
});

test('apiFetch with allowAppForbidden still bounces empty-reason 403 and all 401 responses', async () => {
  for (const { status, body } of [
    { status: 403, body: { error: 'Authentication required', reason: '' } },
    { status: 401, body: { error: 'Authentication required', reason: 'path_outside_root' } },
  ]) {
    const restore = stubGlobals(jsonResponse({ status, ok: false, body }));
    try {
      const { apiFetch } = await import(API_URL);
      await assert.rejects(
        () => apiFetch('/api/fs', { allowAppForbidden: true }),
        /Not authenticated/,
      );
      assert.equal(restore.seen.redirects.length, 1, `status ${status} must bounce`);
    } finally {
      restore();
    }
  }
});

test('apiFetch without the opt-in bounces a 403 even when it carries a reason', async () => {
  const restore = stubGlobals(jsonResponse({
    status: 403,
    ok: false,
    body: { error: 'Path not allowed', reason: 'path_outside_root' },
  }));
  try {
    const { apiFetch } = await import(API_URL);
    await assert.rejects(() => apiFetch('/api/fs'), /Not authenticated/);
    assert.equal(restore.seen.redirects.length, 1, 'default behaviour is unchanged');
  } finally {
    restore();
  }
});

test('apiFetch never forwards allowAppForbidden to fetch()', async () => {
  const restore = stubGlobals(jsonResponse({ status: 200, ok: true, body: { ok: true } }));
  try {
    const { apiFetch } = await import(API_URL);
    await apiFetch('/api/fs', { allowAppForbidden: true, method: 'GET' });
    const [opts] = restore.seen.fetchOpts;
    assert.equal(opts.allowAppForbidden, undefined);
    assert.equal(opts.method, 'GET');
    assert.equal(opts.credentials, 'same-origin');
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
