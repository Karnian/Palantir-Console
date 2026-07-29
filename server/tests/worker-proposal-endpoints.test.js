'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createApp, resolveWorkerProposalEndpoints } = require('../app');

test('explicit worker proposal base is shared by local and remote workers', () => {
  assert.deepEqual(resolveWorkerProposalEndpoints({
    explicitBaseUrl: 'https://console.tailnet.example/',
    host: '0.0.0.0',
    port: 4177,
  }), {
    local: 'https://console.tailnet.example',
    remote: 'https://console.tailnet.example',
  });
});

test('explicit worker proposal base rejects URL userinfo without echoing it', () => {
  for (const explicitBaseUrl of [
    'http://proposal-user:proposal-password@console.internal:4177',
    'http://secret-user\\:secret-pass@127.0.0.1:4177',
  ]) {
    assert.throws(
      () => resolveWorkerProposalEndpoints({ explicitBaseUrl }),
      (err) => (
        err.code === 'WORKER_API_BASE_USERINFO'
        && /userinfo/.test(err.message)
        && !/proposal-user|proposal-password|secret-user|secret-pass/.test(err.message)
      ),
    );
  }
});

test('RFC 6874 scoped IPv6 proposal base is preserved and does not block app boot', async (t) => {
  const explicitBaseUrl = 'http://[fe80::1%25eth0]:4177/proxy-prefix';
  assert.deepEqual(resolveWorkerProposalEndpoints({ explicitBaseUrl }), {
    local: explicitBaseUrl,
    remote: explicitBaseUrl,
  });

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'palantir-scoped-ipv6-base-'));
  const app = createApp({
    storageRoot: tmp,
    fsRoot: tmp,
    dbPath: path.join(tmp, 'test.db'),
    authToken: null,
    pmToken: null,
    agentProcessIsolation: false,
    workerProposalBaseUrl: explicitBaseUrl,
    memoryDistillEnabled: false,
    operatorSchedulerEnabled: false,
  });
  t.after(async () => {
    try { await app.shutdown(); } catch { /* ignore */ }
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  assert.equal(typeof app.shutdown, 'function');
});

test('local worker proposal base follows a concrete bind host without enabling remote loopback', () => {
  assert.deepEqual(resolveWorkerProposalEndpoints({
    host: '192.168.10.4',
    port: 5188,
  }), {
    local: 'http://192.168.10.4:5188',
    remote: null,
  });
  assert.deepEqual(resolveWorkerProposalEndpoints({
    host: '0.0.0.0',
    port: 4177,
  }), {
    local: 'http://127.0.0.1:4177',
    remote: null,
  });
});
