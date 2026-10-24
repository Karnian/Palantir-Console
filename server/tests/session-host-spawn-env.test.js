'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { buildChildEnv, assertChildEnv } = require('../sessionHost/spawnEnv');
const { forbiddenAuthEnv } = require('../sessionHost/pin');
test('env accepts only base and SDK allowlists and a single matching marker', () => {
  const baseEnv = { HOME: '/home', PATH: '/bin', PALANTIR_TOKEN: 'secret', ORCA_TOKEN: 'secret' };
  const sdkEnv = { CLAUDE_AGENT_SDK_VERSION: '0.3.308', HOME: '/wrong', PALANTIR_TOKEN: 'secret' };
  for (const key of forbiddenAuthEnv) baseEnv[key] = sdkEnv[key] = 'secret';
  const env = buildChildEnv({ baseEnv, sdkEnv, incarnationId: '12345678-1234-4abc-8abc-123456789abc' });
  assert.deepEqual({ ...env }, { HOME: '/home', PATH: '/bin', CLAUDE_AGENT_SDK_VERSION: '0.3.308', PALANTIR_OWNED_INCARNATION: '12345678-1234-4abc-8abc-123456789abc' });
  assert.equal(assertChildEnv(env, '12345678-1234-4abc-8abc-123456789abc'), true);
});
test('final env checks have passing controls for every one-field violation', () => {
  const good = buildChildEnv({ incarnationId: '12345678-1234-4abc-8abc-123456789abc' });
  const invalid = [{ ...good, PALANTIR_TOKEN: 'secret' }, { ...good, PALANTIR_OWNED_INCARNATION: '12345678-1234-4abc-8abc-123456789abd' },
    { ...good, HOME: 'sk-ant-value' }, { ...good, 'PALANTIR_OWNED_INCARNATION=other': 'x' },
    ...forbiddenAuthEnv.map(key => ({ ...good, [key]: '' }))];
  const missing = Object.assign(Object.create(null), good);
  delete missing.PALANTIR_OWNED_INCARNATION;
  invalid.push(missing);
  for (const bad of invalid.map(value => Object.assign(Object.create(null), value))) {
    assert.equal(assertChildEnv(good, '12345678-1234-4abc-8abc-123456789abc'), true);
    assert.throws(() => assertChildEnv(bad, '12345678-1234-4abc-8abc-123456789abc'), { code: 'invalid_child_env' });
  }
  for (const id of ['', 'inc 1', 'inc\n1', 'inc=1']) {
    assert.doesNotThrow(() => buildChildEnv({ incarnationId: '12345678-1234-4abc-8abc-123456789abc' }));
    assert.throws(() => buildChildEnv({ incarnationId: id }), { code: 'invalid_child_env' });
  }
});
