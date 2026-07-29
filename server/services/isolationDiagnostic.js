'use strict';

const {
  buildActorTokenAppOptions,
  resolveAppActorTokenPolicy,
} = require('./actorTokenPolicy');

const CHECK_IDS = Object.freeze({
  HUMAN_TOKEN: 'human_token',
  PROCESS_ISOLATION_ATTESTATION: 'process_isolation_attestation',
});

/**
 * Diagnose the exact environment inputs that gate run-bound capabilities.
 *
 * Keep the gate predicates explicit, then compare them with the shared
 * createApp policy-input resolver over a truth table. This catches both policy
 * changes and drift in production option/environment precedence.
 */
function diagnoseIsolation(env = process.env, {
  platform = process.platform,
  arch = process.arch,
  uid = typeof process.getuid === 'function' ? process.getuid() : null,
} = {}) {
  const actorTokenFile = typeof env.PALANTIR_ACTOR_TOKEN_FILE === 'string'
    ? env.PALANTIR_ACTOR_TOKEN_FILE.trim()
    : '';
  const actorTokenFileConfigured = actorTokenFile.length > 0;
  // A configured one-shot file takes precedence over ambient credentials in
  // prepareActorTokenEnvironment. Do not claim that the ambient token is what
  // the server will use, and do not consume the file from a diagnostic command.
  const humanTokenPresent = !actorTokenFileConfigured && !!(
    typeof env.PALANTIR_TOKEN === 'string'
    && env.PALANTIR_TOKEN
  );
  const isolationAttested = env.PALANTIR_AGENT_PROCESS_ISOLATION === 'verified';
  const policy = actorTokenFileConfigured
    ? null
    : resolveAppActorTokenPolicy(buildActorTokenAppOptions({ env }), env);

  const checks = [
    {
      id: CHECK_IDS.HUMAN_TOKEN,
      ok: humanTokenPresent,
      required: 'a non-empty PALANTIR_TOKEN in the policy input',
      // PALANTIR_ACTOR_TOKEN_FILE is the RECOMMENDED deployment: index.js
      // consumes that one-shot file at boot and hands the token to createApp as
      // an option, so it is never an environment variable this can read. Calling
      // that "missing" would report NOT READY for the very setup the runbook
      // tells operators to use — a diagnostic that disagrees with the server is
      // the failure this tool exists to prevent, so say what is actually true:
      // the answer is not determinable from the environment alone.
      indeterminate: actorTokenFileConfigured,
      actual: humanTokenPresent
        ? 'present'
        : (actorTokenFileConfigured
          ? 'not evaluable — PALANTIR_ACTOR_TOKEN_FILE is set and is consumed at boot, not exported'
          : 'missing'),
      remediation: humanTokenPresent
        ? null
        : (actorTokenFileConfigured
          ? 'Nothing to fix if that file holds a valid PALANTIR_TOKEN — this check cannot read it without consuming it. Confirm from the running server, or re-run in a separate process with PALANTIR_ACTOR_TOKEN_FILE unset and PALANTIR_TOKEN set to a non-secret placeholder.'
          : 'Configure PALANTIR_TOKEN, or start the Console through PALANTIR_ACTOR_TOKEN_FILE so bootstrap supplies it as application-owned state.'),
    },
    {
      id: CHECK_IDS.PROCESS_ISOLATION_ATTESTATION,
      ok: isolationAttested,
      required: 'PALANTIR_AGENT_PROCESS_ISOLATION=verified',
      actual: typeof env.PALANTIR_AGENT_PROCESS_ISOLATION === 'string'
        && env.PALANTIR_AGENT_PROCESS_ISOLATION
        ? env.PALANTIR_AGENT_PROCESS_ISOLATION
        : 'missing',
      remediation: isolationAttested
        ? null
        : 'Do not set verified until every capability-bearing agent is separated from the Console and its peers by an OS-user or container boundary.',
    },
  ];

  const capabilitiesEnabled = checks.every((check) => check.ok);
  // A check that is unknown must not hide a different, definite failed gate.
  // Exit 3 is reserved for cases where every known requirement passes.
  const hasIndeterminateCheck = checks.some((check) => check.indeterminate);
  const hasDefiniteFailure = checks.some((check) => !check.ok && !check.indeterminate);
  const indeterminate = hasIndeterminateCheck && !hasDefiniteFailure;
  // index.js only supplies an assured source after successful one-shot-file
  // bootstrap. Without that bootstrap it forces `environment`, regardless of
  // an ambient PALANTIR_ACTOR_TOKEN_SOURCE value.
  const sourceAssured = actorTokenFileConfigured;

  return {
    schemaVersion: 1,
    capabilitiesEnabled,
    indeterminate,
    boundary: policy ? policy.boundary : null,
    checks,
    advisories: [
      {
        id: 'token_source_assurance',
        level: sourceAssured ? 'info' : 'warning',
        ok: sourceAssured,
        message: sourceAssured
          ? 'PALANTIR_ACTOR_TOKEN_FILE takes precedence; a successful bootstrap supplies an assured one-shot-file source.'
          : 'Token-source assurance is not a capabilitiesEnabled gate, but direct environment credentials produce run_capabilities_unverified.',
      },
      {
        id: 'os_boundary_manual_verification',
        level: 'warning',
        ok: null,
        message: 'The runtime treats verified as an operator attestation; this command cannot prove the OS/container boundary or safely upgrade a same-UID topology.',
      },
    ],
    host: {
      platform,
      arch,
      uid: Number.isInteger(uid) ? uid : null,
    },
  };
}

module.exports = {
  CHECK_IDS,
  diagnoseIsolation,
};
