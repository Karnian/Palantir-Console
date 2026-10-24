'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { buildChildEnv, assertChildEnv } = require('../sessionHost/spawnEnv');
const { forbiddenAuthEnv } = require('../sessionHost/pin');
test('env accepts only base and SDK allowlists and a single matching marker', () => {
  const baseEnv = { HOME: '/home', PATH: '/bin', PALANTIR_TOKEN: 'secret', ORCA_TOKEN: 'secret' };
  const sdkEnv = { CLAUDE_AGENT_SDK_VERSION: '0.3.308', HOME: '/wrong', PALANTIR_TOKEN: 'secret' };
  for (const key of forbiddenAuthEnv) baseEnv[key] = sdkEnv[key] = 'secret';
  const env = buildChildEnv({ baseEnv, sdkEnv, incarnationId: 'inc_1' });
  assert.deepEqual(env, { HOME: '/home', PATH: '/bin', CLAUDE_AGENT_SDK_VERSION: '0.3.308', PALANTIR_OWNED_INCARNATION: 'inc_1' });
  assert.equal(assertChildEnv(env, 'inc_1'), true);
});
test('final env checks have passing controls for every one-field violation', () => {
  const good = buildChildEnv({ incarnationId: 'inc_1' });
  const invalid = [{ ...good, PALANTIR_TOKEN: 'secret' }, { ...good, PALANTIR_OWNED_INCARNATION: 'inc_10' },
    { ...good, HOME: 'sk-ant-value' }, { ...good, 'PALANTIR_OWNED_INCARNATION=other': 'x' },
    ...forbiddenAuthEnv.map(key => ({ ...good, [key]: '' }))];
  const missing = { ...good };
  delete missing.PALANTIR_OWNED_INCARNATION;
  invalid.push(missing);
  for (const bad of invalid) {
    assert.equal(assertChildEnv(good, 'inc_1'), true);
    assert.throws(() => assertChildEnv(bad, 'inc_1'), { code: 'invalid_child_env' });
  }
  for (const id of ['', 'inc 1', 'inc\n1', 'inc=1']) {
    assert.doesNotThrow(() => buildChildEnv({ incarnationId: 'inc_1' }));
    assert.throws(() => buildChildEnv({ incarnationId: id }), { code: 'invalid_child_env' });
  }
});
