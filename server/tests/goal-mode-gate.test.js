// G2 §6 — goal-mode activation gate + spawn-env human-token scrub (Codex BLOCKER-1).

const test = require('node:test');
const assert = require('node:assert/strict');

const { goalModeEnabled, pmTokenSeparated, goalFeatureActive, goalModeDiagnostic } = require('../services/goalMode');
const { buildManagerSpawnEnv } = require('../services/authResolver');

test('goalFeatureActive: requires mode ON and a SEPARATED PM token', () => {
  // mode off → never active
  assert.equal(goalFeatureActive({ PALANTIR_GOAL_MODE: '0', PALANTIR_TOKEN: 'h', PALANTIR_PM_TOKEN: 'pm' }), false);
  // mode on but no PM token → fail-closed
  assert.equal(goalFeatureActive({ PALANTIR_GOAL_MODE: '1', PALANTIR_TOKEN: 'h' }), false);
  // mode on but PM token == human token → NOT separated → fail-closed
  assert.equal(goalFeatureActive({ PALANTIR_GOAL_MODE: '1', PALANTIR_TOKEN: 'h', PALANTIR_PM_TOKEN: 'h' }), false);
  // mode on + distinct PM token → active
  assert.equal(goalFeatureActive({ PALANTIR_GOAL_MODE: '1', PALANTIR_TOKEN: 'h', PALANTIR_PM_TOKEN: 'pm' }), true);
  // PM token separated even with no human token (dev)
  assert.equal(goalFeatureActive({ PALANTIR_GOAL_MODE: '1', PALANTIR_PM_TOKEN: 'pm' }), true);
  assert.equal(goalModeEnabled({ PALANTIR_GOAL_MODE: '1' }), true);
  assert.equal(pmTokenSeparated({ PALANTIR_TOKEN: 'h', PALANTIR_PM_TOKEN: 'h' }), false);
});

test('goalModeDiagnostic: null when off, fail-closed warning when unseparated', () => {
  assert.equal(goalModeDiagnostic({ PALANTIR_GOAL_MODE: '0' }), null);
  const disabled = goalModeDiagnostic({ PALANTIR_GOAL_MODE: '1', PALANTIR_TOKEN: 'h' });
  assert.equal(disabled.active, false);
  assert.match(disabled.message, /DISABLED \(fail-closed/);
  const active = goalModeDiagnostic({ PALANTIR_GOAL_MODE: '1', PALANTIR_TOKEN: 'h', PALANTIR_PM_TOKEN: 'pm' });
  assert.equal(active.active, true);
  assert.match(active.message, /ACTIVE/);
});

test('buildManagerSpawnEnv: scrubHumanToken removes PALANTIR_TOKEN, keeps PM token', () => {
  const base = { PATH: '/bin', PALANTIR_TOKEN: 'human-secret', PALANTIR_PM_TOKEN: 'pm-secret', HOME: '/h' };
  const scrubbed = buildManagerSpawnEnv({ baseEnv: base, scrubHumanToken: true });
  assert.equal(scrubbed.PALANTIR_TOKEN, undefined, 'human token removed');
  assert.equal(scrubbed.PALANTIR_PM_TOKEN, 'pm-secret', 'PM token retained');
  assert.equal(scrubbed.PATH, '/bin', 'other env untouched');
});

test('buildManagerSpawnEnv: without scrub (non-goal) PALANTIR_TOKEN passes through unchanged', () => {
  const base = { PATH: '/bin', PALANTIR_TOKEN: 'human-secret', PALANTIR_PM_TOKEN: 'pm-secret' };
  const passthrough = buildManagerSpawnEnv({ baseEnv: base });
  assert.equal(passthrough.PALANTIR_TOKEN, 'human-secret', 'non-goal deployments are byte-identical');
  assert.equal(passthrough.PALANTIR_PM_TOKEN, 'pm-secret');
});

test('buildManagerSpawnEnv: scrub is defense-in-depth against authEnv smuggling the human token back', () => {
  const base = { PALANTIR_TOKEN: 'human-secret' };
  const scrubbed = buildManagerSpawnEnv({ baseEnv: base, authEnv: { PALANTIR_TOKEN: 'sneaky' }, scrubHumanToken: true });
  assert.equal(scrubbed.PALANTIR_TOKEN, undefined, 'authEnv cannot re-introduce the human token under scrub');
});
