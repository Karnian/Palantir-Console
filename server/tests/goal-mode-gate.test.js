// G2 §6 — goal-mode activation gate + spawn-env human-token scrub (Codex BLOCKER-1).

const test = require('node:test');
const assert = require('node:assert/strict');

const { goalModeEnabled, pmTokenSeparated, goalFeatureActive, goalModeDiagnostic } = require('../services/goalMode');
const { buildManagerSpawnEnv } = require('../services/authResolver');
const {
  applyManagerCredentialPolicy,
  resolveActorTokenPolicy,
} = require('../services/actorTokenPolicy');

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

test('final manager spawn env contains no global actor token and only the run capability', () => {
  const base = {
    PATH: '/bin',
    HOME: '/h',
    PALANTIR_TOKEN: 'human-secret',
    PALANTIR_PM_TOKEN: 'pm-secret',
    PALANTIR_MANAGER_TOKEN: 'stale-manager',
  };
  const actorTokens = resolveActorTokenPolicy({
    ...base,
    PALANTIR_AGENT_PROCESS_ISOLATION: 'verified',
  });
  const finalEnv = applyManagerCredentialPolicy(
    buildManagerSpawnEnv({
      baseEnv: base,
      authEnv: { PALANTIR_TOKEN: 'sneaky' },
      scrubHumanToken: true,
    }),
    { managerToken: 'run-bound-manager', actorTokens },
  );

  assert.equal(Object.prototype.hasOwnProperty.call(finalEnv, 'PALANTIR_TOKEN'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(finalEnv, 'PALANTIR_PM_TOKEN'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(finalEnv, 'PALANTIR_WORKER_TOKEN'), false);
  assert.equal(finalEnv.PALANTIR_MANAGER_TOKEN, 'run-bound-manager');
  assert.equal(finalEnv.PATH, '/bin');
});
