'use strict';

const { resolveActorTokenPolicy } = require('./actorTokenPolicy');

const CHECK_IDS = Object.freeze({
  HUMAN_TOKEN: 'human_token',
  PROCESS_ISOLATION_ATTESTATION: 'process_isolation_attestation',
});

/**
 * Diagnose the exact environment inputs that gate run-bound capabilities.
 *
 * Keep these predicates independent from resolveActorTokenPolicy on purpose.
 * The lock-step test compares both implementations over a truth table, so a
 * future runtime-policy edit cannot silently leave an obsolete diagnostic
 * behind.
 */
function diagnoseIsolation(env = process.env, {
  platform = process.platform,
  arch = process.arch,
  uid = typeof process.getuid === 'function' ? process.getuid() : null,
} = {}) {
  const humanTokenPresent = !!(
    typeof env.PALANTIR_TOKEN === 'string'
    && env.PALANTIR_TOKEN
  );
  const isolationAttested = env.PALANTIR_AGENT_PROCESS_ISOLATION === 'verified';
  const policy = resolveActorTokenPolicy(env);

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
      indeterminate: !humanTokenPresent && !!(
        typeof env.PALANTIR_ACTOR_TOKEN_FILE === 'string' && env.PALANTIR_ACTOR_TOKEN_FILE
      ),
      actual: humanTokenPresent
        ? 'present'
        : (typeof env.PALANTIR_ACTOR_TOKEN_FILE === 'string' && env.PALANTIR_ACTOR_TOKEN_FILE
          ? 'not evaluable — PALANTIR_ACTOR_TOKEN_FILE is set and is consumed at boot, not exported'
          : 'missing'),
      remediation: humanTokenPresent
        ? null
        : (typeof env.PALANTIR_ACTOR_TOKEN_FILE === 'string' && env.PALANTIR_ACTOR_TOKEN_FILE
          ? 'Nothing to fix if that file holds a valid PALANTIR_TOKEN — this check cannot read it without consuming it. Confirm from the running server, or re-run with PALANTIR_TOKEN set to any placeholder to exercise the rest of the policy.'
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
  const sourceAssured = env.PALANTIR_ACTOR_TOKEN_SOURCE === 'ephemeral_file'
    || env.PALANTIR_ACTOR_TOKEN_SOURCE === 'application_options';

  // capabilitiesEnabled deliberately still mirrors resolveActorTokenPolicy for
  // THIS env — the two must never disagree. `indeterminate` is a separate axis:
  // the policy is right that this environment does not enable capabilities, and
  // also this environment is not what the server will actually see. Reporting a
  // flat NOT READY for the recommended file-based deployment is what would make
  // the tool untrustworthy.
  const indeterminate = checks.some((check) => check.indeterminate);

  return {
    schemaVersion: 1,
    capabilitiesEnabled,
    indeterminate,
    boundary: policy.boundary,
    checks,
    advisories: [
      {
        id: 'token_source_assurance',
        level: sourceAssured ? 'info' : 'warning',
        ok: sourceAssured,
        message: sourceAssured
          ? 'Actor credentials are marked as application-owned or one-shot-file sourced.'
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
