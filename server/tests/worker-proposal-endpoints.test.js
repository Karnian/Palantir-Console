'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveWorkerProposalEndpoints } = require('../app');

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
  assert.throws(
    () => resolveWorkerProposalEndpoints({
      explicitBaseUrl: 'http://proposal-user:proposal-password@console.internal:4177',
    }),
    (err) => (
      err.code === 'WORKER_API_BASE_USERINFO'
      && /userinfo/.test(err.message)
      && !/proposal-user|proposal-password/.test(err.message)
    ),
  );
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
