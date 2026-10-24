'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const pin = require('../sessionHost/pin');
const gate = require('../sessionHost/authGate');
const account = () => ({ email: 'person@example.test', organization: 'org', subscriptionType: 'Claude Max', apiProvider: 'firstParty' });
const init = () => ({ account: account(), pid: 123, claude_code_version: pin.cliVersion,
  current_permission_mode: 'default', remote_control_auto_enable: false });
const evaluate = value => gate.evaluateInitialization(value, { expectedPid: 123, pin });
const settings = () => ({ effective: { env: {} }, sources: [], provenance: {} });
function rejectedWithControl(bad, good, fn) {
  assert.equal(fn(good).ok, true);
  assert.equal(fn(bad).ok, false);
}
test('pins and nested lists are frozen', () => {
  assert.ok(Object.isFrozen(pin));
  for (const value of Object.values(pin)) if (Array.isArray(value)) assert.ok(Object.isFrozen(value));
});
test('six measured accounts: only subscription passes, with individual field controls', () => {
  const measured = [
    account(),
    { tokenSource: 'claude.ai', apiKeySource: 'ANTHROPIC_API_KEY', apiProvider: 'firstParty' },
    { tokenSource: 'ANTHROPIC_AUTH_TOKEN', apiProvider: 'firstParty' },
    { tokenSource: 'CLAUDE_CODE_OAUTH_TOKEN', apiProvider: 'firstParty' },
    { tokenSource: 'apiKeyHelper', apiKeySource: 'apiKeyHelper', apiProvider: 'firstParty' },
    { apiProvider: 'bedrock' }
  ];
  measured.forEach((value, index) => assert.equal(evaluate({ ...init(), account: value }).ok, index === 0));
  for (const value of measured.slice(1)) {
    for (const [key, field] of Object.entries(value)) {
      if (key === 'apiProvider' && field === 'firstParty') continue;
      rejectedWithControl({ ...init(), account: { ...account(), [key]: field } }, init(), evaluate);
    }
  }
});
test('account missing, unknown, failed, and present undefined credential fields reject', () => {
  for (const key of ['apiProvider', 'subscriptionType']) {
    const bad = init();
    delete bad.account[key];
    rejectedWithControl(bad, init(), evaluate);
  }
  for (const [key, value] of [['subscriptionType', 'Claude Pro'], ['tokenSource', undefined], ['apiKeySource', undefined], ['future', true]]) {
    rejectedWithControl({ ...init(), account: { ...account(), [key]: value } }, init(), evaluate);
  }
  for (const value of [undefined, null, [], 'failed']) rejectedWithControl({ ...init(), account: value }, init(), evaluate);
  assert.equal(gate.evaluateAccountRecheck(account(), account()).ok, true);
  for (const value of [null, {}, { ...account(), email: 'changed@example.test' }, { ...account(), apiProvider: 'unknown' }]) {
    rejectedWithControl(value, account(), current => gate.evaluateAccountRecheck(account(), current));
  }
  assert.equal(JSON.stringify(evaluate({ ...init(), account: null })).includes('person'), false);
});
test('every initialization binding has a passing one-field control', () => {
  for (const [key, value] of [['pid', 124], ['claude_code_version', 'other'], ['current_permission_mode', 'bypassPermissions'],
    ['remote_control_auto_enable', true], ['remote_control_auto_enable', undefined]]) {
    rejectedWithControl({ ...init(), [key]: value }, init(), evaluate);
  }
});
test('settings auth overrides and structural failures fail closed', () => {
  for (const key of pin.forbiddenAuthEnv) {
    const good = settings();
    good.provenance.env = { source: 'project', path: '/tmp/settings.json' };
    const bad = structuredClone(good);
    bad.effective.env[key] = 'secret-value';
    rejectedWithControl(bad, good, gate.evaluateResolvedSettings);
    assert.equal(gate.evaluateResolvedSettings(bad).detail, '/tmp/settings.json');
    assert.equal(JSON.stringify(gate.evaluateResolvedSettings(bad)).includes('secret-value'), false);
  }
  const helper = settings();
  helper.effective.apiKeyHelper = undefined;
  rejectedWithControl(helper, settings(), gate.evaluateResolvedSettings);
  for (const mutate of [value => delete value.effective, value => { value.effective.env.A = 1; },
    value => { value.sources = {}; }, value => { value.provenance = null; }, value => { value.effective.env = []; }]) {
    const bad = settings();
    mutate(bad);
    rejectedWithControl(bad, settings(), gate.evaluateResolvedSettings);
  }
});
test('hook warning and provenance projections contain paths only', () => {
  const value = settings();
  value.effective.hooks = { PermissionRequest: [] };
  value.provenance.hooks = [{ source: 'user', path: '/user/settings.json', value: 'secret' }];
  value.provenance.mcpServers = { test: { source: 'project', path: '/project/mcp.json' } };
  assert.deepEqual(gate.evaluateResolvedSettings(value), { ok: true, warnings: ['permission_request_hook'],
    hookSources: ['/user/settings.json'], mcpSources: ['/project/mcp.json'] });
});
test('checked resolver rejects missing function, throw, malformed results and injected ten-second stall', async () => {
  const good = async ({ cwd }) => { assert.equal(cwd, '/work'); return settings(); };
  assert.equal((await gate.resolveSettingsChecked(good, '/work')).ok, true);
  for (const fn of [undefined, () => { throw Error('secret'); }, () => ({ sources: [], provenance: {} })]) {
    assert.equal((await gate.resolveSettingsChecked(good, '/work')).ok, true);
    assert.deepEqual(await gate.resolveSettingsChecked(fn, '/work'), { ok: false, reason: 'settings_check_failed' });
  }
  let callback;
  let cleared = false;
  const timers = { setTimeout(fn, delay) { assert.equal(delay, 10000); callback = fn; return 1; },
    clearTimeout(id) { assert.equal(id, 1); cleared = true; } };
  const pending = gate.resolveSettingsChecked(() => new Promise(() => {}), '/work', { timers, clock: () => 0 });
  callback();
  assert.deepEqual(await pending, { ok: false, reason: 'settings_check_failed' });
  assert.ok(cleared);
});
test('checked resolver validates every required structure and enforces clock deadline', async () => {
  for (const mutate of [value => delete value.effective, value => { value.effective.env.A = false; },
    value => { value.sources = 'bad'; }, value => { value.provenance = []; }]) {
    const bad = settings();
    mutate(bad);
    assert.equal((await gate.resolveSettingsChecked(() => settings(), '/work')).ok, true);
    assert.deepEqual(await gate.resolveSettingsChecked(() => bad, '/work'), { ok: false, reason: 'settings_check_failed' });
  }
  let elapsed = 0;
  assert.equal((await gate.resolveSettingsChecked(() => settings(), '/work', { clock: () => elapsed })).ok, true);
  const result = await gate.resolveSettingsChecked(() => { elapsed = 10000; return settings(); }, '/work', { clock: () => elapsed });
  assert.deepEqual(result, { ok: false, reason: 'settings_check_failed' });
});
test('system init subscription and both capabilities required', () => {
  const good = { type: 'system', subtype: 'init', apiKeySource: 'none', capabilities: [...pin.requiredCapabilities] };
  rejectedWithControl({ ...good, apiKeySource: 'ANTHROPIC_API_KEY' }, good, gate.evaluateSystemInit);
  for (const capability of pin.requiredCapabilities) {
    rejectedWithControl({ ...good, capabilities: good.capabilities.filter(value => value !== capability) }, good, gate.evaluateSystemInit);
  }
});
