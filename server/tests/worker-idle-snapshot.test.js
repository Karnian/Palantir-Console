const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const { createLifecycleService } = require('../services/lifecycleService');
const {
  MAX_EVENT_BYTES,
  MAX_TREE_NODES,
  collectWorkerSnapshot,
  serializeWorkerSnapshot,
} = require('../services/workerSnapshot');

function makeIdleLifecycle({ collector, onOrder } = {}) {
  const order = [];
  const events = [];
  const run = {
    id: 'run_idle_1',
    status: 'running',
    is_manager: 0,
    agent_profile_id: 'profile_idle_1',
    node_id: 'local',
    task_id: null,
    started_at: '2026-07-31 00:00:00',
    created_at: '2026-07-31 00:00:00',
  };
  let status = 'running';
  let aliveChecks = 0;

  const runService = {
    listRuns(filter = {}) {
      return filter.status === 'running' && status === 'running' ? [{ ...run, status }] : [];
    },
    getLatestActivityAt() { return '2026-07-31 00:00:00'; },
    getRunEvents() { return events; },
    addRunEvent(runId, eventType, payloadJson) {
      events.push({ run_id: runId, event_type: eventType, payload_json: payloadJson });
      order.push(`event:${eventType}`);
    },
    updateRunStatus(runId, nextStatus) {
      assert.equal(runId, run.id);
      status = nextStatus;
      order.push(`status:${nextStatus}`);
      return { ...run, status };
    },
    getRun() { return { ...run, status }; },
  };
  const nodeExecutor = {
    spawnWorker() {},
    ownerOf() { return 'cli'; },
    isAlive() {
      aliveChecks += 1;
      // First health pass primes the output hash. The second pass enters the
      // idle branch, then its liveness recheck observes the dead process.
      return aliveChecks < 3;
    },
    detectExitCode() { return null; },
    getOutput() { return ''; },
    kill() { order.push('kill'); return true; },
  };
  const executionEngine = {
    type: 'subprocess',
    hasProcess() { return false; },
    isAlive() { return false; },
    listSessions() { return []; },
  };
  const lifecycle = createLifecycleService({
    runService,
    taskService: {},
    agentProfileService: {
      getProfile() {
        return {
          id: run.agent_profile_id,
          type: 'codex',
          command: 'codex',
          args_template: 'exec --model model-name',
          idle_timeout_ms: 1,
        };
      },
    },
    projectService: {},
    executionEngine,
    streamJsonEngine: null,
    nodeExecutor,
    worktreeService: null,
    eventBus: null,
    now: () => Date.parse('2026-07-31T02:00:00Z'),
    workerSnapshotCollector: collector || (async () => ({
      run_id: run.id,
      profile_id: run.agent_profile_id,
      node_id: 'local',
    })),
  });
  onOrder?.(order);
  return { lifecycle, order, events, getStatus: () => status };
}

test('idle snapshot event is emitted before terminalization and kill', async () => {
  const fixture = makeIdleLifecycle();

  await fixture.lifecycle.checkHealth();
  await fixture.lifecycle.checkHealth();

  const snapshotIndex = fixture.order.indexOf('event:worker:idle_snapshot');
  assert.notEqual(snapshotIndex, -1);
  assert.ok(snapshotIndex < fixture.order.indexOf('status:failed'));
  assert.ok(snapshotIndex < fixture.order.indexOf('kill'));
  assert.equal(fixture.getStatus(), 'failed');
});

test('snapshot collection failure never escapes or changes the existing idle outcome', async () => {
  const fixture = makeIdleLifecycle({
    collector: async () => { throw new Error('collector contained a secret'); },
  });

  await assert.doesNotReject(fixture.lifecycle.checkHealth());
  await assert.doesNotReject(fixture.lifecycle.checkHealth());

  assert.equal(fixture.getStatus(), 'failed');
  assert.ok(fixture.order.includes('kill'));
  assert.equal(
    fixture.events.some(event => event.event_type === 'worker:idle_snapshot'),
    false,
  );
  assert.equal(JSON.stringify(fixture.events).includes('collector contained a secret'), false);
});

test('argv values are byte-length redacted while exact known flags survive', () => {
  const payload = serializeWorkerSnapshot({
    run_id: 'run_1',
    profile_id: 'profile_1',
    node_id: 'local',
    profile: {
      type: 'codex',
      command: 'codex',
      args_template: '--model gpt-secret --mystery another-secret',
    },
    argv: ['/opt/homebrew/bin/codex', '--model', '한글', 'safe-looking', '--model=secret'],
  });

  assert.deepEqual(payload.profile.args_template_keys, ['--model', '<unknown-flag>']);
  assert.deepEqual(payload.argv, [
    'codex',
    '--model',
    `<redacted:${Buffer.byteLength('한글', 'utf8')}>`,
    `<redacted:${Buffer.byteLength('safe-looking', 'utf8')}>`,
    `<redacted:${Buffer.byteLength('--model=secret', 'utf8')}>`,
  ]);
});

test('tree state and executable basename normalize fail-closed', () => {
  const payload = serializeWorkerSnapshot({
    run_id: 'run_1',
    profile_id: 'profile_1',
    node_id: 'local',
    profile: { type: 'codex', command: 'codex' },
    tree: [{
      pid: 12,
      ppid: 1,
      pgid: 12,
      state: 'X+',
      cputime_s: 1.25,
      exe_basename: '/tmp/bad name',
      cmdline: 'must never persist',
    }],
  });

  assert.deepEqual(payload.tree, [{
    pid: 12,
    ppid: 1,
    pgid: 12,
    cputime_s: 1.25,
    state: '?',
    exe_basename: '<invalid>',
  }]);
  assert.equal(JSON.stringify(payload).includes('cmdline'), false);
});

test('tree and event byte caps truncate whole fields and produce valid JSON', () => {
  const payload = serializeWorkerSnapshot({
    run_id: 'run_1',
    profile_id: 'profile_1',
    node_id: 'local',
    profile: {
      type: 'codex',
      command: 'codex',
      args_template_keys: Array.from({ length: 3000 }, () => '--model'),
    },
    argv: ['/bin/codex', ...Array.from({ length: 3000 }, () => 'value-shaped-token')],
    tree: Array.from({ length: 100 }, (_, index) => ({
      pid: index + 1,
      ppid: index,
      pgid: 1,
      state: 'S',
      cputime_s: index / 10,
      exe_basename: `worker-${index}`,
    })),
  });
  const json = JSON.stringify(payload);

  assert.equal(payload.truncated, true);
  assert.ok(payload.tree.length <= MAX_TREE_NODES);
  assert.ok(Buffer.byteLength(json, 'utf8') <= MAX_EVENT_BYTES);
  assert.deepEqual(JSON.parse(json), payload);
});

test('env and every non-allowlisted field are absent under hostile input', () => {
  const payload = serializeWorkerSnapshot({
    run_id: 'run_1',
    profile_id: 'profile_1',
    node_id: 'local',
    env: { SECRET_ENV_NAME: 'TOP_SECRET_VALUE' },
    profile: {
      type: 'codex',
      command: 'codex',
      env: { SECRET_ENV_NAME: 'TOP_SECRET_VALUE' },
      env_allowlist: ['SECRET_ENV_NAME'],
    },
    argv: ['/bin/codex', 'TOP_SECRET_VALUE'],
    tree: [{
      pid: 1,
      ppid: 0,
      pgid: 1,
      state: 'S',
      cputime_s: 0,
      exe_basename: 'codex',
      environ: 'SECRET_ENV_NAME=TOP_SECRET_VALUE',
    }],
    unexpected: 'TOP_SECRET_VALUE',
  });
  const json = JSON.stringify(payload);

  assert.equal(json.includes('SECRET_ENV_NAME'), false);
  assert.equal(json.includes('TOP_SECRET_VALUE'), false);
  assert.equal(json.includes('env_allowlist'), false);
  assert.equal(Object.hasOwn(payload, 'env'), false);
});

test('ids, custom commands, timestamps, and collection errors use fixed serialization', () => {
  const command = '/operator/private/custom-agent';
  const hash = crypto.createHash('sha256').update(command).digest('hex').slice(0, 8);
  const payload = serializeWorkerSnapshot({
    run_id: '../../bad',
    profile_id: 'profile_ok',
    node_id: 'node with spaces',
    profile: { type: 'future-agent', command },
    last_output_at: 'not-a-date',
    collect_errors: ['ps_failed', 'raw secret error', 'ps_failed'],
  });

  assert.equal(payload.run_id, '<invalid-id>');
  assert.equal(payload.profile_id, 'profile_ok');
  assert.equal(payload.node_id, '<invalid-id>');
  assert.equal(payload.profile.command, `custom:${hash}`);
  assert.equal(payload.profile.type, 'other');
  assert.equal(payload.last_output_at, null);
  assert.deepEqual(payload.collect_errors, ['ps_failed']);
});

test('bounded collector converts executor failure to fixed codes and never throws', async () => {
  const snapshot = await collectWorkerSnapshot({
    run: { id: 'run_1', agent_profile_id: 'profile_1', node_id: 'remote_1' },
    profile: { type: 'codex', command: 'codex', env: { SECRET: 'value' } },
    remote: true,
    executor: { exec: async () => { throw new Error('ssh raw secret'); } },
    timeoutMs: 50,
  });

  assert.deepEqual(snapshot.collect_errors, ['remote_timeout']);
  assert.equal(JSON.stringify(snapshot).includes('ssh raw secret'), false);
  assert.equal(JSON.stringify(snapshot).includes('SECRET'), false);
});

test('remote collection obtains FD counts through the executor without persisting paths', async () => {
  const calls = [];
  const executor = {
    async exec(command, args) {
      calls.push([command, ...args]);
      if (command === 'tmux') return { code: 0, stdout: '123\n', stderr: '' };
      if (command === 'ps' && args[0] === '-axo') {
        return { code: 0, stdout: '123 1 123 S 00:01 /usr/bin/codex\n', stderr: '' };
      }
      if (command === 'ps') {
        return { code: 0, stdout: '/usr/bin/codex --model private-model\n', stderr: '' };
      }
      if (command === 'ls') {
        return {
          code: 0,
          stdout: [
            'l-wx------ 1 user user 64 now 1 -> /private/output.log',
            'lrwx------ 1 user user 64 now 2 -> socket:[123]',
            'lr-x------ 1 user user 64 now 3 -> pipe:[456]',
            'lrwx------ 1 user user 64 now 4 -> anon_inode:[eventpoll]',
          ].join('\n'),
          stderr: '',
        };
      }
      throw new Error('unexpected command');
    },
  };
  const snapshot = await collectWorkerSnapshot({
    run: {
      id: 'run_remote_1',
      agent_profile_id: 'profile_1',
      node_id: 'remote_1',
      tmux_session: 'palantir-run-run_remote_1',
    },
    profile: { type: 'codex', command: 'codex' },
    remote: true,
    executor,
  });
  const json = JSON.stringify(snapshot);

  assert.deepEqual(snapshot.fd_summary, { file: 1, socket: 1, pipe: 1, other: 1 });
  assert.ok(calls.some(call => call[0] === 'ls'));
  assert.equal(json.includes('/private/output.log'), false);
  assert.equal(json.includes('private-model'), false);
});

test('collector outer boundary handles unexpected hostile getters', async () => {
  const hostileRun = new Proxy({}, {
    get() { throw new Error('hostile getter secret'); },
  });
  const snapshot = await collectWorkerSnapshot({ run: hostileRun });

  assert.deepEqual(snapshot.collect_errors, ['proc_unreadable']);
  assert.equal(JSON.stringify(snapshot).includes('hostile getter secret'), false);
});

// --- codex adversarial review (post-delegation) -----------------------------

test('an unknown executable basename is hashed, not passed through', () => {
  // A basename is attacker-influenced input: a remote executor's ps output, or a
  // worker that exec'd a temp file. `/tmp/ARGV_SECRET_9C2D` has a basename that
  // passes any character-class check, so a format-only guard leaks it verbatim.
  const payload = serializeWorkerSnapshot({
    argv: ['/tmp/ARGV_SECRET_9C2D', '--resume'],
    tree: [{ pid: 1, ppid: 0, pgid: 1, state: 'S', exe_basename: '/tmp/TREE_SECRET_7F3A' }],
  });

  const json = JSON.stringify(payload);
  assert.equal(json.includes('ARGV_SECRET_9C2D'), false, 'argv[0] must not carry a raw name');
  assert.equal(json.includes('TREE_SECRET_7F3A'), false, 'exe_basename must not carry a raw name');
  assert.match(payload.argv[0], /^custom:[0-9a-f]{8}$/);
  assert.match(payload.tree[0].exe_basename, /^custom:[0-9a-f]{8}$/);

  // Known executables still pass through — the point is observability, and the
  // hash is stable so identical binaries still group.
  const known = serializeWorkerSnapshot({ argv: ['/usr/local/bin/node'] });
  assert.equal(known.argv[0], 'node');
  const again = serializeWorkerSnapshot({ argv: ['/tmp/ARGV_SECRET_9C2D'] });
  assert.equal(again.argv[0], payload.argv[0], 'the same basename hashes identically');
});

test('a reversed parent chain stays linear and does not stall the caller', async () => {
  // codex measured a 3.08s SYNCHRONOUS stall on an 18k-row reversed chain with
  // timeoutMs=50: a collection deadline cannot cover synchronous work, so the
  // work itself has to be linear. S0 must never delay the kill it precedes.
  const n = 18000;
  const rows = [];
  for (let pid = n; pid >= 1; pid -= 1) {
    rows.push(`${pid} ${pid === 1 ? 0 : pid - 1} 1 S 0:01 x`);
  }
  const table = rows.join('\n');
  const executor = {
    async exec(command, args) {
      if (command === 'tmux') return { code: 0, stdout: '1\n' };
      if (command === 'ps' && args[0] === '-axo') return { code: 0, stdout: table };
      if (command === 'ps') return { code: 0, stdout: '/usr/bin/codex' };
      return { code: 0, stdout: '' };
    },
  };

  const started = process.hrtime.bigint();
  const result = await collectWorkerSnapshot({
    run: { id: 'run_1', agent_profile_id: 'profile_1', node_id: 'remote_1' },
    profile: { type: 'codex', command: 'codex' },
    remote: true,
    executor,
    timeoutMs: 50,
  });
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;

  assert.ok(result.tree.length <= MAX_TREE_NODES);
  assert.ok(
    elapsedMs < 1500,
    `collection took ${Math.round(elapsedMs)}ms on ${n} rows — the tree walk regressed to superlinear`,
  );
});
