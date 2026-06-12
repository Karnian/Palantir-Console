const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const childProcess = require('node:child_process');

const fixtureOpencodeBin = path.join(__dirname, 'fixtures', 'bin', 'fake-opencode.js');

function loadServiceWithSpawn(spawnImpl) {
  const modulePath = require.resolve('../services/opencodeService');
  const originalSpawn = childProcess.spawn;
  delete require.cache[modulePath];
  childProcess.spawn = spawnImpl;
  const { createOpencodeService } = require('../services/opencodeService');
  return {
    createOpencodeService,
    restore() {
      delete require.cache[modulePath];
      childProcess.spawn = originalSpawn;
    }
  };
}

function createFakeChild() {
  const child = new EventEmitter();
  child.unref = () => {};
  process.nextTick(() => child.emit('spawn'));
  return child;
}

test('opencodeService defaults NODE_TLS_REJECT_UNAUTHORIZED to 1', async () => {
  const seen = [];
  const original = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
  delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;

  const harness = loadServiceWithSpawn((bin, args, opts) => {
    seen.push({ bin, args, opts });
    return createFakeChild();
  });

  try {
    const service = harness.createOpencodeService({ opencodeBin: fixtureOpencodeBin });
    const result = await service.queueMessage({ sessionId: 'ses_1', content: 'hello', cwd: '/tmp' });
    assert.deepEqual(result, { status: 'ok', queued: true });
    assert.equal(seen.length, 1);
    assert.equal(seen[0].opts.env.NODE_TLS_REJECT_UNAUTHORIZED, '1');
  } finally {
    if (original === undefined) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
    else process.env.NODE_TLS_REJECT_UNAUTHORIZED = original;
    harness.restore();
  }
});

test('opencodeService preserves an explicit NODE_TLS_REJECT_UNAUTHORIZED override', async () => {
  const seen = [];
  const original = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

  const harness = loadServiceWithSpawn((bin, args, opts) => {
    seen.push({ bin, args, opts });
    return createFakeChild();
  });

  try {
    const service = harness.createOpencodeService({ opencodeBin: fixtureOpencodeBin });
    await service.queueMessage({ sessionId: 'ses_2', content: 'hello', cwd: '/tmp' });
    assert.equal(seen[0].opts.env.NODE_TLS_REJECT_UNAUTHORIZED, '0');
  } finally {
    if (original === undefined) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
    else process.env.NODE_TLS_REJECT_UNAUTHORIZED = original;
    harness.restore();
  }
});
