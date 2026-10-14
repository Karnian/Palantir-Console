'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');
const { fixture } = require('./session-hub-fixture.cjs');
const store = require('../../services/observeSnapshotStore');
const { createAnswerQueryService } = require('../../services/answerQueryService');
const SCRIPT = path.resolve(__dirname, '../fixtures/bin/fake-answer-cli.cjs');
const BODY = 'ANSWER_SERVER_BODY_SENTINEL';
function setup(t, mode = 'ok', extra = {}) {
  // Isolate token-enabled apps and their inherited subprocess environment from host workers.
  const isolation = fs.mkdtempSync(path.join(os.tmpdir(), 'answer-env-'));
  const keys = ['TMPDIR', 'TMUX_TMPDIR', 'HOME', 'STORAGE'];
  const before = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  keys.forEach(key => { process.env[key] = isolation; });
  const fx = fixture(t);
  const log = path.join(fx.root, 'calls.log');
  const env = { ...process.env, PALANTIR_BLOCK_REAL_SPAWN: '1', PALANTIR_ALLOW_REAL_SPAWN: '0',
    PALANTIR_SNAPSHOT_TARGETS: JSON.stringify(['alpha', 'beta', 'gamma'].map(machineId =>
      ({ name: machineId, machineId, kind: 'local' }))),
    PALANTIR_SNAPSHOT_REFRESH_MS: '0', FAKE_ANSWER_MODE: mode, FAKE_ANSWER_LOG: log };
  const services = [];
  let spawns = 0;
  const options = { env, observeState: fx.state, scriptPath: SCRIPT, warn() {},
    reapOptions: { termMs: 20, reapMs: 3000, pollMs: 5 },
    spawn(command, argv, opts) {
      spawns++;
      const id = argv[argv.indexOf('--instruction') + 1];
      return spawn(command, argv, { ...opts, env: { ...opts.env,
        FAKE_ANSWER_MACHINE: id.startsWith('codex:') ? 'beta' : id.includes('gamma') ? 'gamma' : 'alpha' } });
    }, ...extra };
  const service = createAnswerQueryService(options); services.push(service);
  function query(machineId = 'alpha', index = 0) {
    const result = store.readSnapshotHashed(fx.state, machineId);
    const instruction = result.snapshot.instructions[index];
    return { machineId, sessionKey: instruction.session_key, instructionId: instruction.id, rev: result.sha256 };
  }
  t.after(async () => {
    for (const value of services) await value.shutdown();
    keys.forEach(key => { if (before[key] === undefined) delete process.env[key]; else process.env[key] = before[key]; });
    fs.rmSync(isolation, { recursive: true, force: true });
  });
  return { ...fx, log, env, options, service, query, spawns: () => spawns,
    calls: () => fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse) : [],
    newService(overrides) { const value = createAnswerQueryService({ ...options, ...overrides }); services.push(value); return value; },
    url(input = query()) { return '/api/observe/answers?' + new URLSearchParams({ machine: input.machineId,
      key: input.sessionKey, instruction: input.instructionId, rev: input.rev }); } };
}
async function until(check) {
  const deadline = Date.now() + 5000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('fixture_timeout');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}
module.exports = { setup, until, SCRIPT, BODY };
