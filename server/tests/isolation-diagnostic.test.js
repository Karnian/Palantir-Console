'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const {
  buildActorTokenAppOptions,
  consumeActorTokenFile,
  resolveAppActorTokenPolicy,
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

function runDiagnosticAsPlatform(args, overrides, platform) {
  const launcher = [
    `Object.defineProperty(process, 'platform', { value: ${JSON.stringify(platform)} });`,
    `process.argv = [process.execPath, ${JSON.stringify(scriptPath)}, ...${JSON.stringify(args)}];`,
    `import(${JSON.stringify(scriptPath)});`,
  ].join('\n');
  return spawnSync(process.execPath, ['--eval', launcher], {
    cwd: path.resolve(__dirname, '../..'),
    env: cleanProcessEnv(overrides),
    encoding: 'utf8',
  });
}

test('isolation diagnostic stays lock-step with the policy inputs used by createApp', () => {
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

        // Both functions are the exact production seams invoked by index.js
        // and createApp, so ambient source labels cannot make this comparison
        // vacuous.
        const policy = resolveAppActorTokenPolicy(
          buildActorTokenAppOptions({ env }),
          env,
        );
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

test('app actor token policy snapshots accessor-backed token options', () => {
  let authReads = 0;
  let pmReads = 0;
  const options = {
    agentProcessIsolation: true,
    execAttestation: { verified: true, reason: 'test' },
  };
  Object.defineProperties(options, {
    authToken: {
      enumerable: true,
      get() {
        authReads += 1;
        return authReads === 1 ? 'first-human' : 'late-human';
      },
    },
    pmToken: {
      enumerable: true,
      get() {
        pmReads += 1;
        return pmReads === 1 ? 'first-pm' : 'late-pm';
      },
    },
  });

  const policy = resolveAppActorTokenPolicy(options, {});

  assert.deepEqual({
    authReads,
    pmReads,
    humanToken: policy.humanToken,
    agentToken: policy.agentToken,
    boundary: policy.boundary,
  }, {
    authReads: 1,
    pmReads: 1,
    humanToken: 'first-human',
    agentToken: 'first-pm',
    boundary: 'run_capabilities',
  });
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

test('diagnose:isolation --json fails closed when the exec environment exposes the token', () => {
  const secret = 'json-redaction-canary';
  const result = runDiagnostic(['--json'], {
    PALANTIR_TOKEN: secret,
    PALANTIR_AGENT_PROCESS_ISOLATION: 'verified',
    PALANTIR_ACTOR_TOKEN_SOURCE: 'ephemeral_file',
  });

  assert.equal(result.status, 2, result.stderr);
  assert.equal(result.stderr, '');
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.capabilitiesEnabled, false);
  assert.equal(parsed.boundary, 'agent_capabilities_unattested');
  assert.equal(parsed.execAttestation.verified, false);
  assert.ok(['token_in_exec_environ', 'unsupported_platform'].includes(parsed.execAttestation.reason));
  assert.equal(parsed.checks.every((check) => check.ok), true);
  assert.equal(parsed.advisories[0].level, 'warning');
  assert.equal(result.stdout.includes(secret), false);
});

test('diagnose:isolation rejects unknown options with exit 1 JSON', () => {
  const result = runDiagnostic(['--json', '--unknown']);

  assert.equal(result.status, 1, result.stderr);
  assert.equal(result.stderr, '');
  const parsed = JSON.parse(result.stdout);
  assert.match(parsed.error, /unknown option/);
});

test('a definite failed gate takes precedence over an unknown file-backed token', () => {
  const result = runDiagnostic(['--json'], {
    PALANTIR_ACTOR_TOKEN_FILE: '/missing/token.json',
  });

  assert.equal(result.status, 2, result.stderr);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.capabilitiesEnabled, false);
  assert.equal(parsed.indeterminate, false);
  assert.equal(parsed.checks[0].indeterminate, true);
  assert.equal(parsed.checks[1].ok, false);

  const whitespace = runDiagnostic(['--json'], {
    PALANTIR_ACTOR_TOKEN_FILE: '   ',
  });
  assert.equal(whitespace.status, 2, whitespace.stderr);
  const whitespaceParsed = JSON.parse(whitespace.stdout);
  assert.equal(whitespaceParsed.indeterminate, false);
  assert.equal(whitespaceParsed.checks[0].indeterminate, false);
  assert.equal(whitespaceParsed.checks[0].actual, 'missing');
});

test('one-shot file precedence makes an ambient token indeterminate, not ready', () => {
  const result = runDiagnostic(['--json'], {
    PALANTIR_TOKEN: 'ambient-canary',
    PALANTIR_ACTOR_TOKEN_FILE: '/missing/token.json',
    PALANTIR_AGENT_PROCESS_ISOLATION: 'verified',
  });

  assert.equal(result.status, 3, result.stderr);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.capabilitiesEnabled, false);
  assert.equal(parsed.indeterminate, true);
  assert.equal(parsed.boundary, null);
  assert.equal(parsed.checks[0].indeterminate, true);
  assert.equal(result.stdout.includes('ambient-canary'), false);
});

test('Windows token-file diagnostics fail exactly as bootstrap does', () => {
  const env = {
    PALANTIR_ACTOR_TOKEN_FILE: 'C:\\secure\\tokens.json',
    PALANTIR_AGENT_PROCESS_ISOLATION: 'verified',
  };

  assert.throws(
    () => consumeActorTokenFile({ env: { ...env }, platform: 'win32' }),
    /PALANTIR_ACTOR_TOKEN_FILE is unsupported on Windows because its ACL cannot be verified/,
  );

  const diagnostic = diagnoseIsolation(env, {
    platform: 'win32',
    arch: 'x64',
    uid: null,
  });
  assert.equal(diagnostic.capabilitiesEnabled, false);
  assert.equal(diagnostic.indeterminate, false);
  assert.equal(diagnostic.boundary, null);
  assert.equal(diagnostic.checks[0].ok, false);
  assert.equal(diagnostic.checks[0].indeterminate, false);
  assert.match(diagnostic.checks[0].actual, /unsupported on Windows/);
  assert.match(diagnostic.checks[0].remediation, /Unset PALANTIR_ACTOR_TOKEN_FILE/);
  assert.equal(diagnostic.advisories[0].level, 'warning');
  assert.equal(diagnostic.advisories[0].ok, false);

  const cli = runDiagnosticAsPlatform(['--json'], env, 'win32');
  assert.equal(cli.status, 2, cli.stderr);
  const parsed = JSON.parse(cli.stdout);
  assert.equal(parsed.indeterminate, false);
  assert.equal(parsed.checks[0].indeterminate, false);
  assert.match(parsed.checks[0].actual, /unsupported on Windows/);
});

test('ambient source labels cannot claim the application-owned production boundary', () => {
  const result = runDiagnostic(['--json'], {
    PALANTIR_TOKEN: 'source-canary',
    PALANTIR_ACTOR_TOKEN_SOURCE: 'ephemeral_file',
    PALANTIR_AGENT_PROCESS_ISOLATION: 'verified',
  });

  assert.equal(result.status, 2, result.stderr);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.capabilitiesEnabled, false);
  assert.equal(parsed.boundary, 'agent_capabilities_unattested');
  assert.equal(parsed.execAttestation.verified, false);
  assert.equal(parsed.advisories[0].level, 'warning');
  assert.equal(parsed.advisories[0].ok, false);
  assert.equal(result.stdout.includes('source-canary'), false);
});

test('production bootstrap options replace ambient actor inputs', () => {
  const env = {
    PALANTIR_TOKEN: 'ambient-human',
    PALANTIR_PM_TOKEN: 'ambient-pm',
    PALANTIR_ACTOR_TOKEN_SOURCE: 'application_options',
    PALANTIR_AGENT_PROCESS_ISOLATION: 'verified',
  };
  const options = buildActorTokenAppOptions({
    env,
    actorTokenBootstrap: {
      source: 'ephemeral_file',
      authToken: 'file-human',
      pmToken: 'file-pm',
    },
  });
  options.execAttestation = { verified: true, reason: 'test' };
  const policy = resolveAppActorTokenPolicy(options, env);

  assert.equal(options.actorTokenSource, 'ephemeral_file');
  assert.equal(policy.humanToken, 'file-human');
  assert.equal(policy.agentToken, 'file-pm');
  assert.equal(policy.boundary, 'run_capabilities');
});

test('the recommended file-based deployment CLI reports an indeterminate state', () => {
  // index.js consumes PALANTIR_ACTOR_TOKEN_FILE at boot and passes the token to
  // createApp as an option, so it never becomes an environment variable. A flat
  // "missing" here would tell an operator running the documented secure recipe
  // that they are NOT READY when the server would in fact enable capabilities —
  // a diagnostic disagreeing with the runtime is the failure this tool exists
  // to prevent.
  const result = runDiagnostic([], {
    PALANTIR_ACTOR_TOKEN_FILE: '/secure/tokens.json',
    PALANTIR_AGENT_PROCESS_ISOLATION: 'verified',
  });

  assert.equal(result.status, 3, result.stderr);
  assert.match(result.stdout, /^Agent capability isolation: INDETERMINATE$/m);
  assert.match(result.stdout, /^  UNKNOWN human_token$/m);
  assert.match(
    result.stdout,
    /^Policy boundary: not evaluable until PALANTIR_ACTOR_TOKEN_FILE is consumed$/m,
  );
  assert.match(result.stdout, /^  INFO token_source_assurance:/m);
  assert.doesNotMatch(result.stdout, /NOT READY/);
  assert.doesNotMatch(result.stdout, /^  FAIL human_token$/m);
  assert.doesNotMatch(result.stdout, /Policy boundary: auth_disabled/);
  assert.doesNotMatch(result.stdout, /^  WARNING token_source_assurance:/m);
});
