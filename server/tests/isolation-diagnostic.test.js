'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const {
  resolveActorTokenPolicy,
} = require('../services/actorTokenPolicy');
const {
  CHECK_IDS,
  diagnoseIsolation,
} = require('../services/isolationDiagnostic');

const scriptPath = path.resolve(__dirname, '../../scripts/diagnose-isolation.mjs');

function cleanProcessEnv(overrides = {}) {
  const env = { ...process.env };
  delete env.PALANTIR_TOKEN;
  delete env.PALANTIR_PM_TOKEN;
  delete env.PALANTIR_ACTOR_TOKEN_SOURCE;
  delete env.PALANTIR_AGENT_PROCESS_ISOLATION;
  return { ...env, ...overrides };
}

function runDiagnostic(args, overrides = {}) {
  return spawnSync(process.execPath, [scriptPath, ...args], {
    cwd: path.resolve(__dirname, '../..'),
    env: cleanProcessEnv(overrides),
    encoding: 'utf8',
  });
}

test('isolation diagnostic stays lock-step with resolveActorTokenPolicy capabilitiesEnabled', () => {
  const values = [undefined, '', 'other', 'verified'];
  const sources = [undefined, 'environment', 'ephemeral_file', 'application_options'];
  const tokens = [undefined, '', 'human-secret'];

  for (const token of tokens) {
    for (const isolation of values) {
      for (const source of sources) {
        const env = {};
        if (token !== undefined) env.PALANTIR_TOKEN = token;
        if (isolation !== undefined) env.PALANTIR_AGENT_PROCESS_ISOLATION = isolation;
        if (source !== undefined) env.PALANTIR_ACTOR_TOKEN_SOURCE = source;

        const policy = resolveActorTokenPolicy(env);
        const diagnostic = diagnoseIsolation(env, {
          platform: 'test',
          arch: 'test',
          uid: 123,
        });

        assert.equal(
          diagnostic.capabilitiesEnabled,
          policy.capabilitiesEnabled,
          `diagnostic drift for ${JSON.stringify({ token, isolation, source })}`,
        );
        assert.equal(diagnostic.boundary, policy.boundary);
      }
    }
  }
});

test('isolation diagnostic names both blocking requirements without exposing tokens', () => {
  const secret = 'must-never-appear';
  const result = diagnoseIsolation({
    PALANTIR_TOKEN: secret,
    PALANTIR_AGENT_PROCESS_ISOLATION: 'almost',
  });

  assert.deepEqual(
    result.checks.map((check) => check.id),
    [
      CHECK_IDS.HUMAN_TOKEN,
      CHECK_IDS.PROCESS_ISOLATION_ATTESTATION,
    ],
  );
  assert.equal(result.checks[0].ok, true);
  assert.equal(result.checks[0].actual, 'present');
  assert.equal(result.checks[1].ok, false);
  assert.equal(JSON.stringify(result).includes(secret), false);
});

test('diagnose:isolation --json exits 2 with concrete missing requirements', () => {
  const result = runDiagnostic(['--json']);

  assert.equal(result.status, 2, result.stderr);
  assert.equal(result.stderr, '');
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.capabilitiesEnabled, false);
  assert.deepEqual(
    parsed.checks.filter((check) => !check.ok).map((check) => check.id),
    [
      CHECK_IDS.HUMAN_TOKEN,
      CHECK_IDS.PROCESS_ISOLATION_ATTESTATION,
    ],
  );
});

test('diagnose:isolation --json exits 0 when the runtime policy enables capabilities', () => {
  const secret = 'json-redaction-canary';
  const result = runDiagnostic(['--json'], {
    PALANTIR_TOKEN: secret,
    PALANTIR_AGENT_PROCESS_ISOLATION: 'verified',
    PALANTIR_ACTOR_TOKEN_SOURCE: 'ephemeral_file',
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.capabilitiesEnabled, true);
  assert.equal(parsed.boundary, 'run_capabilities');
  assert.equal(parsed.checks.every((check) => check.ok), true);
  assert.equal(result.stdout.includes(secret), false);
});

test('diagnose:isolation rejects unknown options with exit 1 JSON', () => {
  const result = runDiagnostic(['--json', '--unknown']);

  assert.equal(result.status, 1, result.stderr);
  assert.equal(result.stderr, '');
  const parsed = JSON.parse(result.stdout);
  assert.match(parsed.error, /unknown option/);
});

test('the recommended file-based deployment is reported as indeterminate, not as not-ready', () => {
  const { diagnoseIsolation } = require('../services/isolationDiagnostic');
  // index.js consumes PALANTIR_ACTOR_TOKEN_FILE at boot and passes the token to
  // createApp as an option, so it never becomes an environment variable. A flat
  // "missing" here would tell an operator running the documented secure recipe
  // that they are NOT READY when the server would in fact enable capabilities —
  // a diagnostic disagreeing with the runtime is the failure this tool exists
  // to prevent.
  const result = diagnoseIsolation({
    PALANTIR_ACTOR_TOKEN_FILE: '/secure/tokens.json',
    PALANTIR_AGENT_PROCESS_ISOLATION: 'verified',
  });
  assert.equal(result.indeterminate, true);
  const tokenCheck = result.checks.find((check) => check.id === 'human_token');
  assert.equal(tokenCheck.indeterminate, true);
  assert.match(tokenCheck.actual, /not evaluable/);

  // Without that file it is a genuine, determinable failure.
  const plain = diagnoseIsolation({ PALANTIR_AGENT_PROCESS_ISOLATION: 'verified' });
  assert.equal(plain.indeterminate, false);
  assert.equal(plain.checks.find((check) => check.id === 'human_token').actual, 'missing');
});
