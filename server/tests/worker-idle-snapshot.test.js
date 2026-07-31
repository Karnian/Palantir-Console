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

const KNOWN_FLAG_OR_PLACEHOLDER = /^(?:--[a-z0-9-]+|<unknown-flag>)$/;

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

test('shedding an oversized payload stays sub-linear in serializations', () => {
  // codex round 2: the first cap implementation re-serialized the whole payload
  // once per removed element — 535ms at the 4096 argv cap. A deadline cannot
  // cover synchronous work, so shedding itself must not be O(n^2).
  const argv = ['/usr/local/bin/node'];
  for (let i = 0; i < 4096; i += 1) argv.push(`--value-${'x'.repeat(40)}-${i}`);
  const tree = [];
  for (let pid = 1; pid <= 64; pid += 1) {
    tree.push({ pid, ppid: pid - 1, pgid: 1, state: 'S', cputime_s: 1, exe_basename: 'node' });
  }

  const started = process.hrtime.bigint();
  const payload = serializeWorkerSnapshot({ run_id: 'run_1', argv, tree });
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;

  assert.equal(payload.truncated, true);
  assert.ok(
    Buffer.byteLength(JSON.stringify(payload), 'utf8') <= MAX_EVENT_BYTES,
    'the shed payload must fit the cap',
  );
  assert.doesNotThrow(() => JSON.parse(JSON.stringify(payload)));
  // Measured on this input: binary-search shedding ~3ms, per-element ~131ms.
  // 40ms sits an order of magnitude above the good path and well below the bad
  // one, so this fails on the regression without flaking on a loaded machine.
  assert.ok(
    elapsedMs < 40,
    `shedding took ${Math.round(elapsedMs)}ms — the cap loop regressed to per-element serialization`,
  );
});

test('an oversized args_template is bounded and reported as truncated', () => {
  // codex round 3: tokenizing the whole template and only then slicing to the
  // token cap made an oversized profile field pay full parse cost. The read now
  // stops at TEMPLATE_SCAN_BYTES / TOKEN_LIMIT.
  //
  // Deliberately NOT a timing assertion: on this fixture bounded vs unbounded is
  // 2.7ms vs 6.2ms, too narrow to separate reliably. (The two timing tests above
  // keep their assertions because their gaps are 40x and 20x.) What is pinned
  // here is the contract — an oversized template is bounded and says so.
  const template = `${'--flag-'.padEnd(68, 'x')} `.repeat(30000);
  assert.ok(template.length > 1.5 * 1024 * 1024, 'the fixture must actually be oversized');

  const payload = serializeWorkerSnapshot({ run_id: 'run_1', profile: { args_template: template } });

  assert.equal(payload.truncated, true, 'an oversized template must be reported as truncated');
  assert.ok(
    Buffer.byteLength(JSON.stringify(payload), 'utf8') <= MAX_EVENT_BYTES,
    'the payload must still fit the cap',
  );
  assert.ok(
    payload.profile.args_template_keys.every(key => KNOWN_FLAG_OR_PLACEHOLDER.test(key)),
    'every surviving key must be a known flag or the placeholder',
  );
});

test('a single oversized token still reports truncation and drops nothing silently', () => {
  // codex round 4: the first bounded-read fix pushed a sentinel token and relied
  // on the caller's length check. One 256KB token is a SINGLE token — under the
  // cap — so an oversized template reported truncated:false while silently
  // dropping every flag after it.
  const template = `${'x'.repeat(256 * 1024 + 1)} --model`;

  const payload = serializeWorkerSnapshot({ run_id: 'run_1', profile: { args_template: template } });

  assert.equal(
    payload.truncated,
    true,
    'an oversized template must report truncation even when it parses to few tokens',
  );
  assert.ok(
    Buffer.byteLength(JSON.stringify(payload), 'utf8') <= MAX_EVENT_BYTES,
  );
});

test('a nearly spent budget skips the synchronous session lookup', async () => {
  // listSessions() is execFileSync with a 5s timeout in the tmux engine, so it
  // can block the health loop past any deadline we set. With no budget left it
  // must not be called at all.
  let called = 0;
  const executionEngine = {
    listSessions() { called += 1; return []; },
  };
  const executor = { async exec() { return { code: 1, stdout: '', stderr: '' }; } };

  await collectWorkerSnapshot({
    run: { id: 'run_1', agent_profile_id: 'profile_1' },
    profile: { type: 'codex', command: 'codex' },
    executor,
    executionEngine,
    timeoutMs: 1,
  });

  assert.equal(called, 0, 'the synchronous session lookup must be skipped when the budget is spent');
});
