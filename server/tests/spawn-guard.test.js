const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const {
  assertSpawnAllowed,
  isSpawnGuardActive,
  SpawnBlockedError,
} = require('../utils/spawnGuard');

const ENV_KEYS = [
  'NODE_TEST_CONTEXT',
  'PALANTIR_BLOCK_REAL_SPAWN',
  'PALANTIR_ALLOW_REAL_SPAWN',
  'PATH',
];

function withEnv(overrides, fn) {
  const saved = {};
  for (const key of ENV_KEYS) saved[key] = process.env[key];
  try {
    for (const [key, value] of Object.entries(overrides)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    return fn();
  } finally {
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
}

function assertBlocked(command, source = 'spawn-guard-test') {
  assert.throws(
    () => assertSpawnAllowed({ command, source }),
    (err) => {
      assert.ok(err instanceof SpawnBlockedError);
      assert.equal(err.name, 'SpawnBlockedError');
      assert.equal(err.code, 'PALANTIR_SPAWN_BLOCKED');
      assert.equal(err.status, 500);
      assert.equal(err.details.code, 'PALANTIR_SPAWN_BLOCKED');
      assert.equal(err.details.source, source);
      assert.match(err.message, new RegExp(source));
      assert.match(err.message, new RegExp(String(command).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
      return true;
    }
  );
}

test('spawnGuard is inactive without test context or explicit block', () => {
  withEnv({
    NODE_TEST_CONTEXT: undefined,
    PALANTIR_BLOCK_REAL_SPAWN: undefined,
    PALANTIR_ALLOW_REAL_SPAWN: undefined,
  }, () => {
    assert.equal(isSpawnGuardActive(), false);
    assert.doesNotThrow(() => assertSpawnAllowed({
      command: 'definitely-not-present-palantir-test-command',
      source: 'inactive-test',
    }));
  });
});

test('spawnGuard blocks unresolved bare commands when NODE_TEST_CONTEXT exists', () => {
  withEnv({
    NODE_TEST_CONTEXT: 'child-v8',
    PALANTIR_BLOCK_REAL_SPAWN: undefined,
    PALANTIR_ALLOW_REAL_SPAWN: undefined,
  }, () => {
    assert.equal(isSpawnGuardActive(), true);
    assertBlocked('definitely-not-present-palantir-test-command', 'node-test-context');
  });
});

test('spawnGuard blocks when PALANTIR_BLOCK_REAL_SPAWN=1 without node test context', () => {
  withEnv({
    NODE_TEST_CONTEXT: undefined,
    PALANTIR_BLOCK_REAL_SPAWN: '1',
    PALANTIR_ALLOW_REAL_SPAWN: undefined,
  }, () => {
    assert.equal(isSpawnGuardActive(), true);
    assertBlocked('claude', 'explicit-block');
  });
});

test('spawnGuard allows process.execPath while active', () => {
  withEnv({
    NODE_TEST_CONTEXT: 'child-v8',
    PALANTIR_BLOCK_REAL_SPAWN: undefined,
    PALANTIR_ALLOW_REAL_SPAWN: undefined,
  }, () => {
    assert.doesNotThrow(() => assertSpawnAllowed({
      command: process.execPath,
      source: 'node-self',
    }));
  });
});

test('spawnGuard allows executable fixtures by absolute path', () => {
  const fixture = path.join(__dirname, 'fixtures', 'bin', 'fake-claude-stream-json.js');
  withEnv({
    NODE_TEST_CONTEXT: 'child-v8',
    PALANTIR_BLOCK_REAL_SPAWN: undefined,
    PALANTIR_ALLOW_REAL_SPAWN: undefined,
  }, () => {
    assert.doesNotThrow(() => assertSpawnAllowed({
      command: fixture,
      source: 'fixture-absolute',
    }));
  });
});

test('spawnGuard resolves bare PATH commands and allows fixture binaries', () => {
  const fixtureDir = path.join(__dirname, 'fixtures', 'bin');
  const oldPath = process.env.PATH || '';
  withEnv({
    NODE_TEST_CONTEXT: 'child-v8',
    PALANTIR_BLOCK_REAL_SPAWN: undefined,
    PALANTIR_ALLOW_REAL_SPAWN: undefined,
    PATH: [fixtureDir, oldPath].filter(Boolean).join(path.delimiter),
  }, () => {
    assert.doesNotThrow(() => assertSpawnAllowed({
      command: 'fake-claude-stream-json.js',
      source: 'fixture-path',
    }));
  });
});

// ---------------------------------------------------------------------------
// Call-site regression guards.
//
// skill-packs-resolve 류 테스트는 "500 또는 201" 을 둘 다 허용하므로, 엔진에서
// assertSpawnAllowed 호출이 제거돼도 (real CLI 가 PATH 에 있는 머신에서는)
// 그대로 통과해 버린다 — 2026-06-12 spawn storm 이 빠져나간 바로 그 구멍.
// 여기서 engine.spawnAgent 가 SpawnBlockedError 를 던지는 것 자체를 고정한다.
// /bin/echo 는 가드가 깨져도 무해하게 종료되는 real binary 라서 차단 대상 검증에 안전.
// ---------------------------------------------------------------------------

const { createTmuxEngine, createSubprocessEngine } = require('../services/executionEngine');

function assertEngineBlocks(engine, expectedSource) {
  withEnv({
    NODE_TEST_CONTEXT: 'child-v8',
    PALANTIR_BLOCK_REAL_SPAWN: undefined,
    PALANTIR_ALLOW_REAL_SPAWN: undefined,
  }, () => {
    assert.throws(
      () => engine.spawnAgent('run_spawnguard_callsite', {
        command: '/bin/echo',
        args: ['blocked'],
        cwd: __dirname,
        env: {},
      }),
      (err) => {
        assert.ok(err instanceof SpawnBlockedError);
        assert.equal(err.details.source, expectedSource);
        return true;
      }
    );
  });
}

test('call-site: SubprocessEngine.spawnAgent is guarded', () => {
  assertEngineBlocks(createSubprocessEngine(), 'executionEngine:subprocess');
});

test('call-site: TmuxEngine.spawnAgent is guarded (throws before any tmux call)', () => {
  assertEngineBlocks(createTmuxEngine(), 'executionEngine:tmux');
});

test('spawnGuard allows explicit integration-test override', () => {
  withEnv({
    NODE_TEST_CONTEXT: 'child-v8',
    PALANTIR_BLOCK_REAL_SPAWN: '1',
    PALANTIR_ALLOW_REAL_SPAWN: '1',
  }, () => {
    assert.equal(isSpawnGuardActive(), false);
    assert.doesNotThrow(() => assertSpawnAllowed({
      command: 'claude',
      source: 'allow-real-spawn',
    }));
  });
});
