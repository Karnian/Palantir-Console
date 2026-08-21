'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  readExecEnviron,
  attestHumanTokenAbsent,
} = require('../services/execEnvAttestation');
const {
  resolveActorTokenPolicy,
  createManagerCapabilityTokenService,
} = require('../services/actorTokenPolicy');

const isolatedEnv = {
  PALANTIR_TOKEN: 'human-secret',
  PALANTIR_AGENT_PROCESS_ISOLATION: 'verified',
};

test('readExecEnviron reports Linux success, Linux failure, and unsupported platforms', () => {
  assert.deepEqual(
    readExecEnviron({ platform: 'linux', readFile: (path) => {
      assert.equal(path, '/proc/self/environ');
      return Buffer.from('A=1\0');
    } }),
    { readable: true, content: 'A=1\0', reason: 'proc_self_environ' },
  );
  assert.deepEqual(
    readExecEnviron({ platform: 'linux', readFile: () => { throw new Error('denied'); } }),
    { readable: false, content: null, reason: 'environ_unreadable' },
  );
  assert.deepEqual(
    readExecEnviron({ platform: 'darwin', readFile: () => { throw new Error('must not read'); } }),
    { readable: false, content: null, reason: 'unsupported_platform' },
  );
});

test('attestHumanTokenAbsent verifies no token and rejects a copied token value', () => {
  assert.deepEqual(attestHumanTokenAbsent(''), {
    verified: true,
    reason: 'no_human_token',
  });
  assert.deepEqual(attestHumanTokenAbsent('human-secret', {
    readExecEnviron: () => ({
      readable: true,
      content: 'UNRELATED_COPY=prefix-human-secret-suffix\0',
      reason: 'proc_self_environ',
    }),
  }), {
    verified: false,
    reason: 'token_in_exec_environ',
  });
  assert.deepEqual(attestHumanTokenAbsent('human-secret', {
    readExecEnviron: () => ({ readable: true, content: 'OTHER=safe\0', reason: 'proc_self_environ' }),
  }), {
    verified: true,
    reason: 'absent_from_exec_environ',
  });
  assert.deepEqual(attestHumanTokenAbsent('human-secret', {
    readExecEnviron: () => ({ readable: false, content: null, reason: 'environ_unreadable' }),
  }), {
    verified: false,
    reason: 'environ_unreadable',
  });
});

test('isolated policy fails closed without verified exec attestation', () => {
  const policy = resolveActorTokenPolicy(isolatedEnv);
  assert.equal(policy.capabilitiesEnabled, false);
  assert.equal(policy.boundary, 'agent_capabilities_unattested');
});

test('unattested isolated policy prevents manager capability minting', () => {
  const actorTokens = resolveActorTokenPolicy(isolatedEnv);
  const service = createManagerCapabilityTokenService({ actorTokens });
  assert.equal(service.mint('run_top', {
    conversationId: 'top',
    layer: 'top',
  }), null);
});

test('verified exec attestation preserves isolated capabilities', () => {
  const execAttestation = { verified: true, reason: 'test' };
  const policy = resolveActorTokenPolicy(isolatedEnv, { execAttestation });
  assert.equal(policy.capabilitiesEnabled, true);
  assert.equal(policy.boundary, 'run_capabilities_unverified');
  assert.equal(policy.execAttestation, execAttestation);
});

// The cases above inject an attestation. That leaves two things unpinned: that
// anything computes one when the caller does not, and that createApp forwards
// the option. Without these, deleting the default computation would still show
// a green suite while production silently fell back to self-attestation.
const { resolveAppActorTokenPolicy } = require('../services/actorTokenPolicy');
const { createApp } = require('../app');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('an app policy computes its own attestation when the caller supplies none', () => {
  const policy = resolveAppActorTokenPolicy(
    { authToken: 'attestation-default-token', agentProcessIsolation: true },
    {},
  );
  // Platform-independent: on Linux the real read decides, elsewhere it reports
  // unsupported_platform. Either way an attestation must exist and must be what
  // capabilitiesEnabled follows -- never an absent object treated as verified.
  assert.ok(policy.execAttestation, 'a policy must carry the attestation it was gated on');
  // The reason must come from the real attester's vocabulary. Asserting only
  // "is a string" would let a hardcoded default stand in for the read -- which
  // is exactly the self-attestation this change removes.
  assert.ok(
    [
      'no_human_token', 'unsupported_platform', 'environ_unreadable',
      'token_in_exec_environ', 'absent_from_exec_environ',
    ].includes(policy.execAttestation.reason),
    `unexpected attestation reason: ${policy.execAttestation.reason}`,
  );
  assert.equal(policy.capabilitiesEnabled, policy.execAttestation.verified === true);
});

test('createApp forwards the attestation option to the minting gate', async (t) => {
  const roots = [];
  const build = (execAttestation) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'palantir-attest-app-'));
    roots.push(root);
    return createApp({
      dbPath: path.join(root, 'test.db'),
      storageRoot: root,
      fsRoot: root,
      authToken: 'human-token',
      agentProcessIsolation: true,
      execAttestation,
      memoryDistillEnabled: false,
      operatorSchedulerEnabled: false,
      authResolverOpts: { hasKeychain: () => false },
    });
  };
  const refused = build({ verified: false, reason: 'token_in_exec_environ' });
  const allowed = build({ verified: true, reason: 'test' });
  t.after(async () => {
    for (const app of [refused, allowed]) { try { await app.shutdown(); } catch { /* ignore */ } }
    for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
  });

  const mintArgs = ['run-1', { conversationId: 'top', layer: 'top' }];
  assert.equal(refused.services.managerCapabilityTokenService.mint(...mintArgs), null,
    'an unattested app must mint nothing even with isolation declared');
  assert.equal(typeof allowed.services.managerCapabilityTokenService.mint(...mintArgs), 'string',
    'an attested app must still mint');
});

test('the default path really reads the exec environ, it does not assume an answer', () => {
  // A reason from the right vocabulary is not proof: a hardcoded default with a
  // plausible reason passes that. Counting the read is the direct evidence.
  let reads = 0;
  const policy = resolveAppActorTokenPolicy({
    authToken: 'reader-probe-token',
    agentProcessIsolation: true,
    execEnvironReader: () => {
      reads += 1;
      return { readable: true, content: 'HOME=/root\0COPY=reader-probe-token\0', reason: 'proc_self_environ' };
    },
  }, {});

  assert.equal(reads, 1, 'the default attestation must call the environ reader exactly once');
  assert.equal(policy.execAttestation.reason, 'token_in_exec_environ');
  assert.equal(policy.capabilitiesEnabled, false, 'a token visible in the exec environ must gate off');

  // ...and the OUTCOME must follow what the reader returned. Calling it once and
  // ignoring the result would satisfy the count alone.
  const absent = resolveAppActorTokenPolicy({
    authToken: 'reader-probe-token',
    agentProcessIsolation: true,
    execEnvironReader: () => ({ readable: true, content: 'HOME=/root\0', reason: 'proc_self_environ' }),
  }, {});
  assert.equal(absent.execAttestation.reason, 'absent_from_exec_environ');
  assert.equal(absent.capabilitiesEnabled, true);
});

test('with nothing injected at all, the real exec environ decides', () => {
  // The injected-reader probe proves the injected branch. It cannot prove the
  // DEFAULT branch: an implementation that reads only when a reader is supplied
  // and hardcodes otherwise passes it. This one takes no injection, so the only
  // thing that can answer is the real reader.
  const attest = (authToken) => resolveAppActorTokenPolicy(
    { authToken, agentProcessIsolation: true }, {},
  );

  if (process.platform !== 'linux') {
    // Nothing to read: fail closed, and say why. On this platform the probe
    // cannot distinguish a real read from a hardcoded 'unsupported_platform';
    // the Linux branch below (CI, and the deployment target) is where the
    // default path is actually proven.
    const policy = attest('palantir-attestation-probe');
    assert.equal(policy.execAttestation.reason, 'unsupported_platform');
    assert.equal(policy.capabilitiesEnabled, false);
    return;
  }

  // Derive both probes from /proc/self/environ itself. Reading process.env
  // instead would be flaky: a value assigned at RUNTIME (several tests here do
  // exactly that) appears in process.env but never in the exec-time environ, so
  // picking one would make the real implementation answer 'absent' and fail this
  // test for the wrong reason.
  const environ = fs.readFileSync('/proc/self/environ', 'utf8');
  const present = environ
    .split('\0')
    .filter(Boolean)
    .map((entry) => entry.slice(entry.indexOf('=') + 1))
    .find((value) => value.length > 8);
  assert.ok(present, 'the exec environ must carry at least one non-trivial value');

  let absent = 'palantir-attestation-probe-0';
  for (let n = 1; environ.includes(absent); n += 1) absent = `palantir-attestation-probe-${n}`;

  // One constant cannot satisfy both directions -- that is what makes this
  // non-vacuous against a hardcoded default.
  const withPresentToken = attest(present);
  assert.equal(withPresentToken.execAttestation.reason, 'token_in_exec_environ');
  assert.equal(withPresentToken.capabilitiesEnabled, false);

  const withAbsentToken = attest(absent);
  assert.equal(withAbsentToken.execAttestation.reason, 'absent_from_exec_environ');
  assert.equal(withAbsentToken.capabilitiesEnabled, true);

  // The two probes above still pass an implementation that searches process.env
  // instead of the exec environ, because a value taken from environ is normally
  // in process.env too. This one separates the sources: a variable assigned at
  // RUNTIME exists in process.env and can never be in /proc/self/environ, so a
  // process.env search reports it present while the correct read reports absent.
  const runtimeOnly = `palantir-attestation-runtime-only-${absent}`;
  const previous = process.env.PALANTIR_ATTESTATION_RUNTIME_PROBE;
  process.env.PALANTIR_ATTESTATION_RUNTIME_PROBE = runtimeOnly;
  try {
    const policy = attest(runtimeOnly);
    assert.equal(
      policy.execAttestation.reason, 'absent_from_exec_environ',
      'a runtime-only value must read as absent -- finding it means process.env was searched',
    );
    assert.equal(policy.capabilitiesEnabled, true);
  } finally {
    if (previous === undefined) delete process.env.PALANTIR_ATTESTATION_RUNTIME_PROBE;
    else process.env.PALANTIR_ATTESTATION_RUNTIME_PROBE = previous;
  }
});

test('a value present at module load is still absent from the exec environ', () => {
  // The bypass this whole change exists to remove, in the issue's own words: a
  // module-load snapshot of process.env is defeated by import order. Every probe
  // above passes such an implementation, because a snapshot taken at load looks
  // like the exec environ for anything set before it. Setting the value first and
  // loading the module AFTER separates them: the snapshot would contain it, the
  // real /proc/self/environ never can.
  if (process.platform !== 'linux') return;

  const value = `palantir-attestation-preload-${process.pid}-${process.hrtime.bigint()}`;
  const previous = process.env.PALANTIR_ATTESTATION_PRELOAD_PROBE;
  process.env.PALANTIR_ATTESTATION_PRELOAD_PROBE = value;
  const policyPath = require.resolve('../services/actorTokenPolicy');
  const attestPath = require.resolve('../services/execEnvAttestation');
  delete require.cache[policyPath];
  delete require.cache[attestPath];
  try {
    const freshlyLoaded = require('../services/actorTokenPolicy');
    const policy = freshlyLoaded.resolveAppActorTokenPolicy(
      { authToken: value, agentProcessIsolation: true }, {},
    );
    assert.equal(
      policy.execAttestation.reason, 'absent_from_exec_environ',
      'finding a value that was set before module load means a snapshot was consulted',
    );
  } finally {
    if (previous === undefined) delete process.env.PALANTIR_ATTESTATION_PRELOAD_PROBE;
    else process.env.PALANTIR_ATTESTATION_PRELOAD_PROBE = previous;
    delete require.cache[policyPath];
    delete require.cache[attestPath];
  }
});
