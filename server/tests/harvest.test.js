const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');

const { createDatabase } = require('../db/database');
const { createRunService } = require('../services/runService');
const { createTaskService } = require('../services/taskService');
const { createProjectService } = require('../services/projectService');
const { createAgentProfileService } = require('../services/agentProfileService');
const { createWorktreeService } = require('../services/worktreeService');
const {
  createHarvestService,
  buildHarvestEnv,
  defaultNodeResolver,
  resolveDeclaredNodeMajor,
  resolveProjectNode,
  SERVER_NODE_MAJOR,
  MAX_DECL_BYTES,
} = require('../services/harvestService');
const { createLifecycleService } = require('../services/lifecycleService');
const { createEventBus } = require('../services/eventBus');
const { createPmAutoReview } = require('../app');
const { conversationIdForProject } = require('../utils/conversationId');

const fakeRunner = path.join(__dirname, 'fixtures', 'bin', 'fake-test-runner.js');
const injectedTestRunner = { bin: process.execPath, args: [fakeRunner] };
const PROJECT_NODE_MAJOR = SERVER_NODE_MAJOR === 20 ? 22 : 20;

function makeTempDir(t, prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  });
  return dir;
}

function makeFakeNodeBin(t, prefix = 'palantir-node-bin-') {
  const root = makeTempDir(t, prefix);
  const binDir = path.join(root, 'bin');
  fs.mkdirSync(binDir, { recursive: true });
  const nodePath = path.join(binDir, 'node');
  fs.writeFileSync(nodePath, '#!/bin/sh\nexit 0\n');
  fs.chmodSync(nodePath, 0o755);
  return binDir;
}

async function mkdb(t) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'palantir-harvest-db-'));
  const dbPath = path.join(dir, 'test.db');
  const { db, migrate, close } = createDatabase(dbPath);
  migrate();
  t.after(async () => {
    close();
    await fsp.rm(dir, { recursive: true, force: true });
  });
  return db;
}

function makeRepo(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'palantir-harvest-repo-'));
  execFileSync('git', ['init', '-b', 'main'], { cwd: dir, stdio: 'pipe' });
  execFileSync('git', ['config', 'user.email', 'test@test.com'], { cwd: dir, stdio: 'pipe' });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: dir, stdio: 'pipe' });
  fs.writeFileSync(path.join(dir, 'README.md'), '# harvest\n');
  execFileSync('git', ['add', '.'], { cwd: dir, stdio: 'pipe' });
  execFileSync('git', ['commit', '-m', 'init'], { cwd: dir, stdio: 'pipe' });
  t.after(() => {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  });
  return dir;
}

function seedProfile(db) {
  const id = `profile-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  db.prepare(
    `INSERT INTO agent_profiles (id, name, type, command, capabilities_json, env_allowlist, max_concurrent)
     VALUES (?, 'TestAgent', 'codex', 'codex', '{}', '[]', 5)`
  ).run(id);
  return { id };
}

function parseEvent(evt) {
  return JSON.parse(evt.payload_json || '{}');
}

function eventsOf(runService, runId, type) {
  return runService.getRunEvents(runId).filter(evt => evt.event_type === type);
}

function collectChannel(eventBus, channel) {
  const events = [];
  eventBus.subscribe((event) => {
    if (event.channel === channel) events.push(event);
  });
  return events;
}

async function waitFor(predicate, { timeoutMs = 3000, intervalMs = 20 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, intervalMs));
  }
  assert.ok(predicate(), 'condition was not met before timeout');
}

function makeServices(
  db,
  { eventBus = null, worktreeService = createWorktreeService(), nodeResolver = undefined } = {}
) {
  const runService = createRunService(db, eventBus);
  const taskService = createTaskService(db);
  const projectService = createProjectService(db);
  const agentProfileService = createAgentProfileService(db);
  const harvestService = createHarvestService({
    runService,
    worktreeService,
    projectService,
    eventBus,
    testRunner: injectedTestRunner,
    nodeResolver,
  });
  return { runService, taskService, projectService, agentProfileService, worktreeService, harvestService };
}

async function createRunInWorktree({ db, runService, taskService, projectService, worktreeService, repoDir, testCommand = null }) {
  const project = projectService.createProject({
    name: 'Harvest Project',
    directory: repoDir,
    test_command: testCommand,
  });
  const task = taskService.createTask({ project_id: project.id, title: 'Harvest task' });
  const profile = seedProfile(db);
  const queued = runService.createRun({
    task_id: task.id,
    agent_profile_id: profile.id,
    prompt: 'do work',
  });
  const branchName = `palantir/${queued.id.replace(/_/g, '-')}`;
  const wt = await worktreeService.createWorktree(repoDir, branchName);
  const running = runService.markRunStarted(queued.id, {
    tmux_session: `session-${queued.id}`,
    worktree_path: wt.path,
    branch: wt.branch,
  });
  return { project, task, profile, run: running, worktreePath: wt.path, branch: wt.branch };
}

function createRunWithoutWorktree({ db, runService, taskService, projectService, repoDir }) {
  const project = projectService.createProject({
    name: 'Harvest Project',
    directory: repoDir,
  });
  const task = taskService.createTask({ project_id: project.id, title: 'Harvest task' });
  const profile = seedProfile(db);
  const run = runService.createRun({
    task_id: task.id,
    agent_profile_id: profile.id,
    prompt: 'do work',
  });
  return { project, task, profile, run };
}

async function createRunWithMissingProjectDir({ db, runService, taskService, projectService, worktreeService, repoDir }) {
  const project = projectService.createProject({
    name: 'Missing Directory Project',
    directory: null,
  });
  const task = taskService.createTask({ project_id: project.id, title: 'Harvest task' });
  const profile = seedProfile(db);
  const queued = runService.createRun({
    task_id: task.id,
    agent_profile_id: profile.id,
    prompt: 'do work',
  });
  const branchName = `palantir/${queued.id.replace(/_/g, '-')}`;
  const wt = await worktreeService.createWorktree(repoDir, branchName);
  const running = runService.markRunStarted(queued.id, {
    tmux_session: `session-${queued.id}`,
    worktree_path: wt.path,
    branch: wt.branch,
  });
  return { project, task, profile, run: running, worktreePath: wt.path, branch: wt.branch };
}

function makeAutoReviewHarness({
  activeRunId = 'run_pm_1',
  activeSlotRunIds = {},
  throwOnSend = false,
  defer = (fn) => fn(),
  runServiceRuns = [],
  listRunsImpl = null,
  addRunEventImpl = null,
  injectRunService = true,
  resolverImpl = null,
  autoReviewMax = undefined,
} = {}) {
  const eventBus = createEventBus();
  const sent = [];
  const runEvents = [];
  const listRunsCalls = [];
  const warnings = [];
  const slotClearedCallbacks = [];
  let currentActiveRunId = activeRunId;
  let shouldThrow = throwOnSend;
  const resolvedOperators = new Map([
    [conversationIdForProject('proj_1'), {
      instanceId: 'oi_proj_1',
      legacyProjectId: 'proj_1',
      legacySlotId: conversationIdForProject('proj_1'),
      instanceConversationId: conversationIdForProject('oi_proj_1'),
      primaryProjectId: 'proj_1',
    }],
    [conversationIdForProject('oi_proj_1'), {
      instanceId: 'oi_proj_1',
      legacyProjectId: null,
      legacySlotId: conversationIdForProject('proj_1'),
      instanceConversationId: conversationIdForProject('oi_proj_1'),
      primaryProjectId: 'proj_1',
    }],
    [conversationIdForProject('proj_2'), {
      instanceId: 'oi_proj_2',
      legacyProjectId: 'proj_2',
      legacySlotId: conversationIdForProject('proj_2'),
      instanceConversationId: conversationIdForProject('oi_proj_2'),
      primaryProjectId: 'proj_2',
    }],
    [conversationIdForProject('oi_proj_2'), {
      instanceId: 'oi_proj_2',
      legacyProjectId: null,
      legacySlotId: conversationIdForProject('proj_2'),
      instanceConversationId: conversationIdForProject('oi_proj_2'),
      primaryProjectId: 'proj_2',
    }],
    [conversationIdForProject('proj_orphan'), {
      instanceId: null,
      legacyProjectId: 'proj_orphan',
      legacySlotId: conversationIdForProject('proj_orphan'),
      instanceConversationId: null,
      primaryProjectId: null,
    }],
    [conversationIdForProject('oi_no_primary'), {
      instanceId: 'oi_no_primary',
      legacyProjectId: null,
      legacySlotId: null,
      instanceConversationId: conversationIdForProject('oi_no_primary'),
      primaryProjectId: null,
    }],
  ]);
  const fakeRunService = {
    listRuns(query) {
      listRunsCalls.push(query);
      if (listRunsImpl) return listRunsImpl(query);
      return runServiceRuns;
    },
    addRunEvent(runId, eventType, payloadJson) {
      if (addRunEventImpl) return addRunEventImpl(runId, eventType, payloadJson);
      runEvents.push({ runId, eventType, payloadJson });
      return runEvents.length;
    },
    resolveOperatorConversationId(conversationId) {
      if (resolverImpl) return resolverImpl(conversationId);
      return resolvedOperators.get(conversationId) || null;
    },
  };
  const pmSlot = conversationIdForProject('proj_1'); // Phase 2: operator:proj_1
  const activeSlots = new Map(Object.entries({
    [conversationIdForProject('proj_2')]: 'run_pm_2',
    top: 'run_top_1',
    ...activeSlotRunIds,
  }));
  const managerRegistry = {
    getActiveRunId(slot) {
      if (slot === pmSlot) return currentActiveRunId;
      return activeSlots.has(slot) ? activeSlots.get(slot) : null;
    },
    onSlotCleared(cb) {
      slotClearedCallbacks.push(cb);
      return () => {};
    },
  };
  const conversationService = {
    sendMessage(slot, message) {
      if (shouldThrow) throw new Error('send failed');
      sent.push({ slot, message });
    },
  };
  const pmAutoReviewOptions = {
    eventBus,
    managerRegistry,
    conversationService,
    defer,
    logger: { warn: (msg) => warnings.push(String(msg)) },
  };
  if (autoReviewMax !== undefined) pmAutoReviewOptions.autoReviewMax = autoReviewMax;
  if (injectRunService) pmAutoReviewOptions.runService = fakeRunService;
  const controller = createPmAutoReview(pmAutoReviewOptions);
  return {
    eventBus,
    sent,
    runEvents,
    listRunsCalls,
    warnings,
    slotClearedCallbacks,
    controller,
    runService: injectRunService ? fakeRunService : null,
    setActiveRunId(value) { currentActiveRunId = value; },
    setThrowOnSend(value) { shouldThrow = value; },
  };
}

function reviewRun(overrides = {}) {
  return {
    id: 'run_worker_1',
    is_manager: 0,
    project_id: 'proj_1',
    task_id: 'task_1',
    status: 'completed',
    exit_code: 0,
    retry_count: 0,
    result_summary: 'worker done',
    ...overrides,
  };
}

function harvestedSummary(overrides = {}) {
  return {
    files: 2,
    commits: 1,
    statText: ' a.js | 1 +\n b.js | 2 ++',
    test: {
      passed: true,
      timed_out: false,
      exit_code: 0,
      duration_ms: 123,
      output_tail: 'tests passed',
    },
    errors: [],
    harvested: true,
    ...overrides,
  };
}

test('buildHarvestEnv prefixes PATH with the server node bin directory', () => {
  const env = buildHarvestEnv();
  const [firstPathEntry] = env.PATH.split(path.delimiter);

  assert.equal(firstPathEntry, path.dirname(process.execPath));
});

// Stronger guard (Codex cross-review Q4): the string-prefix check above does
// not prove that a shell resolving `node` on this PATH actually lands on the
// server node. Resolve it the way `/bin/sh -c` would — walk PATH for the first
// executable `node` — and assert it is the server's. This is the regression
// the original bug (system node v26 winning) would re-introduce, and the
// reason the 993 existing tests missed it (they inject testRunner=execPath,
// bypassing PATH resolution entirely).
test('buildHarvestEnv PATH resolves `node` to the server node', () => {
  const env = buildHarvestEnv();
  let resolved = null;
  for (const dir of env.PATH.split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, 'node');
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      resolved = fs.realpathSync(candidate);
      break;
    } catch { /* keep walking PATH */ }
  }
  assert.equal(resolved, fs.realpathSync(process.execPath));
});

test('resolveProjectNode uses a declared .nvmrc single major when resolver finds it', (t) => {
  const worktreePath = makeTempDir(t, 'palantir-node-nvmrc-');
  const binDir = makeFakeNodeBin(t);
  fs.writeFileSync(path.join(worktreePath, '.nvmrc'), `v${PROJECT_NODE_MAJOR}.1.0\n`);

  const seen = [];
  const resolved = resolveProjectNode(worktreePath, (major) => {
    seen.push(major);
    return major === PROJECT_NODE_MAJOR ? binDir : null;
  });

  assert.equal(resolveDeclaredNodeMajor(worktreePath), PROJECT_NODE_MAJOR);
  assert.deepEqual(seen, [PROJECT_NODE_MAJOR]);
  assert.deepEqual(resolved, {
    binDir,
    major: PROJECT_NODE_MAJOR,
    source: 'project',
  });
});

test('resolveDeclaredNodeMajor parses exact, caret, and tilde engines single-major declarations', (t) => {
  for (const spec of [
    `${PROJECT_NODE_MAJOR}`,
    `v${PROJECT_NODE_MAJOR}.1.0`,
    `${PROJECT_NODE_MAJOR}.x`,
    `^${PROJECT_NODE_MAJOR}`,
    `~v${PROJECT_NODE_MAJOR}.1`,
  ]) {
    const worktreePath = makeTempDir(t, 'palantir-node-engines-');
    fs.writeFileSync(path.join(worktreePath, 'package.json'), JSON.stringify({
      engines: { node: spec },
    }));

    assert.equal(resolveDeclaredNodeMajor(worktreePath), PROJECT_NODE_MAJOR, spec);
  }
});

test('resolveProjectNode keeps server node when declaration matches server major', (t) => {
  const worktreePath = makeTempDir(t, 'palantir-node-server-major-');
  fs.writeFileSync(path.join(worktreePath, '.nvmrc'), `${SERVER_NODE_MAJOR}\n`);
  let called = false;

  const resolved = resolveProjectNode(worktreePath, () => {
    called = true;
    throw new Error('resolver should not be called for server major');
  });

  assert.equal(called, false);
  assert.deepEqual(resolved, {
    binDir: null,
    major: SERVER_NODE_MAJOR,
    source: 'server',
  });
});

test('resolveProjectNode treats range and dirty declarations as server node', (t) => {
  const cases = [
    { name: 'foo22 nvmrc', nvmrc: 'foo22\n' },
    { name: 'lts nvmrc', nvmrc: 'lts/*\n' },
    { name: 'range engines', engines: `>=${PROJECT_NODE_MAJOR} <${SERVER_NODE_MAJOR + 1}` },
    { name: 'compound engines', engines: `${PROJECT_NODE_MAJOR} || ${SERVER_NODE_MAJOR}` },
    { name: 'hyphen range engines', engines: `${PROJECT_NODE_MAJOR} - ${SERVER_NODE_MAJOR}` },
  ];

  for (const item of cases) {
    const worktreePath = makeTempDir(t, 'palantir-node-dirty-');
    if (item.nvmrc) {
      fs.writeFileSync(path.join(worktreePath, '.nvmrc'), item.nvmrc);
    } else {
      fs.writeFileSync(path.join(worktreePath, 'package.json'), JSON.stringify({
        engines: { node: item.engines },
      }));
    }
    let called = false;
    const resolved = resolveProjectNode(worktreePath, () => {
      called = true;
      throw new Error('ambiguous declarations should not call resolver');
    });

    assert.equal(resolveDeclaredNodeMajor(worktreePath), null, item.name);
    assert.equal(called, false, item.name);
    assert.deepEqual(resolved, {
      binDir: null,
      major: SERVER_NODE_MAJOR,
      source: 'server',
    }, item.name);
  }
});

test('resolveProjectNode falls back to server node when declared node is not installed', (t) => {
  const worktreePath = makeTempDir(t, 'palantir-node-fallback-');
  fs.writeFileSync(path.join(worktreePath, '.nvmrc'), `${PROJECT_NODE_MAJOR}\n`);

  assert.deepEqual(resolveProjectNode(worktreePath, () => null), {
    binDir: null,
    major: PROJECT_NODE_MAJOR,
    source: 'fallback',
  });
});

test('resolveProjectNode keeps server node when no declaration exists', (t) => {
  const worktreePath = makeTempDir(t, 'palantir-node-none-');
  let called = false;

  const resolved = resolveProjectNode(worktreePath, () => {
    called = true;
    return makeFakeNodeBin(t);
  });

  assert.equal(called, false);
  assert.deepEqual(resolved, {
    binDir: null,
    major: SERVER_NODE_MAJOR,
    source: 'server',
  });
});

test('resolveProjectNode never throws on parse, size, symlink, and resolver failures', (t) => {
  const malformed = makeTempDir(t, 'palantir-node-malformed-');
  fs.writeFileSync(path.join(malformed, 'package.json'), '{"engines":');
  assert.doesNotThrow(() => resolveDeclaredNodeMajor(malformed));
  assert.equal(resolveDeclaredNodeMajor(malformed), null);
  assert.equal(resolveProjectNode(malformed).source, 'server');

  const huge = makeTempDir(t, 'palantir-node-huge-');
  fs.writeFileSync(path.join(huge, '.nvmrc'), '2'.repeat(MAX_DECL_BYTES + 1));
  assert.doesNotThrow(() => resolveDeclaredNodeMajor(huge));
  assert.equal(resolveDeclaredNodeMajor(huge), null);
  assert.equal(resolveProjectNode(huge).source, 'server');

  const symlinked = makeTempDir(t, 'palantir-node-symlink-');
  const target = path.join(symlinked, 'target-nvmrc');
  fs.writeFileSync(target, `${PROJECT_NODE_MAJOR}\n`);
  fs.symlinkSync(target, path.join(symlinked, '.nvmrc'));
  assert.doesNotThrow(() => resolveDeclaredNodeMajor(symlinked));
  assert.equal(resolveDeclaredNodeMajor(symlinked), null);
  assert.equal(resolveProjectNode(symlinked).source, 'server');

  const resolverThrow = makeTempDir(t, 'palantir-node-resolver-throw-');
  fs.writeFileSync(path.join(resolverThrow, '.nvmrc'), `${PROJECT_NODE_MAJOR}\n`);
  assert.doesNotThrow(() => resolveProjectNode(resolverThrow, () => {
    throw new Error('resolver failed');
  }));
  assert.deepEqual(resolveProjectNode(resolverThrow, () => {
    throw new Error('resolver failed');
  }), {
    binDir: null,
    major: SERVER_NODE_MAJOR,
    source: 'server',
  });
});

test('defaultNodeResolver honors PALANTIR_NODE_PREFIX and restores env', (t) => {
  const prefix = makeTempDir(t, 'palantir-node-prefix-');
  const binDir = path.join(prefix, `node@${PROJECT_NODE_MAJOR}`, 'bin');
  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(path.join(binDir, 'node'), '#!/bin/sh\nexit 0\n');
  fs.chmodSync(path.join(binDir, 'node'), 0o755);
  const previous = process.env.PALANTIR_NODE_PREFIX;
  process.env.PALANTIR_NODE_PREFIX = prefix;
  try {
    assert.equal(defaultNodeResolver(PROJECT_NODE_MAJOR), binDir);
    assert.equal(defaultNodeResolver(SERVER_NODE_MAJOR + PROJECT_NODE_MAJOR + 1000), null);
  } finally {
    if (previous === undefined) delete process.env.PALANTIR_NODE_PREFIX;
    else process.env.PALANTIR_NODE_PREFIX = previous;
  }
});

test('buildHarvestEnv prefixes PATH with project node bin when resolver finds declared node', (t) => {
  const worktreePath = makeTempDir(t, 'palantir-node-env-');
  const binDir = makeFakeNodeBin(t);
  fs.writeFileSync(path.join(worktreePath, '.nvmrc'), `${PROJECT_NODE_MAJOR}\n`);

  const env = buildHarvestEnv(worktreePath, (major) => (
    major === PROJECT_NODE_MAJOR ? binDir : null
  ));
  const [firstPathEntry] = env.PATH.split(path.delimiter);
  assert.equal(firstPathEntry, binDir);

  let resolved = null;
  for (const dir of env.PATH.split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, 'node');
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      resolved = fs.realpathSync(candidate);
      break;
    } catch { /* keep walking PATH */ }
  }
  assert.equal(resolved, fs.realpathSync(path.join(binDir, 'node')));
});

test('harvestRun emits run:harvested once with diff and test summary for completed worktree runs', async (t) => {
  const db = await mkdb(t);
  const repoDir = makeRepo(t);
  const eventBus = createEventBus();
  const harvestEvents = collectChannel(eventBus, 'run:harvested');
  const services = makeServices(db, { eventBus });
  const { run, worktreePath } = await createRunInWorktree({
    db,
    repoDir,
    testCommand: 'pass',
    ...services,
  });
  fs.writeFileSync(path.join(worktreePath, 'agent-output.txt'), 'agent work\n');
  const completed = services.runService.updateRunStatus(run.id, 'completed', { force: true });

  await services.harvestService.harvestRun(completed, { projectDir: repoDir });

  assert.equal(harvestEvents.length, 1);
  const payload = harvestEvents[0].data;
  assert.equal(payload.run.id, run.id);
  assert.equal(payload.summary.harvested, true);
  assert.equal(payload.summary.files, 1);
  assert.ok(payload.summary.commits >= 1);
  assert.match(payload.summary.statText, /agent-output\.txt/);
  assert.ok(payload.summary.statText.length <= 500);
  assert.equal(payload.summary.test.passed, true);
  assert.equal(payload.summary.test.timed_out, false);
  assert.equal(payload.summary.test.exit_code, 0);
  assert.match(payload.summary.test.output_tail, /fake-test-runner pass/);
  assert.ok(payload.summary.test.output_tail.length <= 500);
  assert.deepEqual(payload.summary.errors, []);
  const testPayload = parseEvent(eventsOf(services.runService, run.id, 'harvest:test')[0]);
  assert.equal(testPayload.node_major, SERVER_NODE_MAJOR);
  assert.equal(testPayload.node_source, 'server');
});

test('harvestRun emits harvested=false once when worktree metadata is absent', async (t) => {
  const db = await mkdb(t);
  const repoDir = makeRepo(t);
  const eventBus = createEventBus();
  const harvestEvents = collectChannel(eventBus, 'run:harvested');
  const services = makeServices(db, { eventBus });
  const { run } = createRunWithoutWorktree({ db, repoDir, ...services });
  const completed = services.runService.updateRunStatus(run.id, 'completed', { force: true });

  await services.harvestService.harvestRun(completed, { projectDir: repoDir });

  assert.equal(harvestEvents.length, 1);
  assert.equal(harvestEvents[0].data.run.id, run.id);
  assert.deepEqual(harvestEvents[0].data.summary, {
    files: 0,
    commits: 0,
    statText: '',
    test: null,
    errors: ['no_worktree'],
    harvested: false,
  });
});

test('harvestRun emits harvested=false once when projectDir cannot be resolved', async (t) => {
  const db = await mkdb(t);
  const repoDir = makeRepo(t);
  const eventBus = createEventBus();
  const harvestEvents = collectChannel(eventBus, 'run:harvested');
  const services = makeServices(db, { eventBus });
  const { run, worktreePath } = await createRunWithMissingProjectDir({ db, repoDir, ...services });
  fs.writeFileSync(path.join(worktreePath, 'agent-output.txt'), 'agent work\n');
  const completed = services.runService.updateRunStatus(run.id, 'completed', { force: true });

  await services.harvestService.harvestRun(completed, { projectDir: null });

  assert.equal(harvestEvents.length, 1);
  assert.equal(harvestEvents[0].data.run.id, run.id);
  assert.deepEqual(harvestEvents[0].data.summary.errors, ['no_project_dir']);
  assert.equal(harvestEvents[0].data.summary.harvested, false);
  const errorEvents = eventsOf(services.runService, run.id, 'harvest:error');
  assert.equal(errorEvents.length, 1);
  assert.equal(parseEvent(errorEvents[0]).stage, 'preflight');
});

test('harvestRun emits harvested=false once when worktree path is already gone', async (t) => {
  const db = await mkdb(t);
  const repoDir = makeRepo(t);
  const eventBus = createEventBus();
  const harvestEvents = collectChannel(eventBus, 'run:harvested');
  const services = makeServices(db, { eventBus });
  const { run, worktreePath } = await createRunInWorktree({ db, repoDir, ...services });
  fs.rmSync(worktreePath, { recursive: true, force: true });
  const completed = services.runService.updateRunStatus(run.id, 'completed', { force: true });

  await services.harvestService.harvestRun(completed, { projectDir: repoDir });

  assert.equal(harvestEvents.length, 1);
  assert.equal(harvestEvents[0].data.run.id, run.id);
  assert.deepEqual(harvestEvents[0].data.summary.errors, ['worktree_missing']);
  assert.equal(harvestEvents[0].data.summary.harvested, false);
});

test('harvestRun emits run:harvested once for failed worktree runs without running tests', async (t) => {
  const db = await mkdb(t);
  const repoDir = makeRepo(t);
  const eventBus = createEventBus();
  const harvestEvents = collectChannel(eventBus, 'run:harvested');
  const services = makeServices(db, { eventBus });
  const { run, worktreePath } = await createRunInWorktree({
    db,
    repoDir,
    testCommand: 'fail',
    ...services,
  });
  fs.writeFileSync(path.join(worktreePath, 'agent-output.txt'), 'agent work\n');
  const failed = services.runService.updateRunStatus(run.id, 'failed', { force: true });

  await services.harvestService.harvestRun(failed, { projectDir: repoDir });

  assert.equal(harvestEvents.length, 1);
  assert.equal(harvestEvents[0].data.run.id, run.id);
  assert.equal(harvestEvents[0].data.summary.harvested, true);
  assert.equal(harvestEvents[0].data.summary.files, 1);
  assert.equal(harvestEvents[0].data.summary.test, null);
});

test('harvestRun does not emit run:harvested for non-review-target runs', async (t) => {
  const db = await mkdb(t);
  const repoDir = makeRepo(t);
  const eventBus = createEventBus();
  const harvestEvents = collectChannel(eventBus, 'run:harvested');
  const services = makeServices(db, { eventBus });

  const cancelledCase = await createRunInWorktree({ db, repoDir, ...services });
  const cancelled = services.runService.updateRunStatus(cancelledCase.run.id, 'cancelled', { force: true });
  await services.harvestService.harvestRun(cancelled, { projectDir: repoDir });

  const stoppedCase = await createRunInWorktree({ db, repoDir, ...services });
  const stopped = services.runService.updateRunStatus(stoppedCase.run.id, 'stopped', { force: true });
  await services.harvestService.harvestRun(stopped, { projectDir: repoDir });

  const runningCase = await createRunInWorktree({ db, repoDir, ...services });
  await services.harvestService.harvestRun(runningCase.run, { projectDir: repoDir });

  const manager = services.runService.createRun({
    is_manager: true,
    prompt: 'manage',
    manager_adapter: 'codex',
    manager_layer: 'top',
    conversation_id: 'top',
  });
  await services.harvestService.harvestRun({
    ...manager,
    status: 'completed',
    is_manager: 1,
    worktree_path: cancelledCase.worktreePath,
    branch: cancelledCase.branch,
  }, { projectDir: repoDir });

  assert.equal(harvestEvents.length, 0);
});

test('harvestRun dedupe prevents duplicate run:harvested emits', async (t) => {
  const db = await mkdb(t);
  const repoDir = makeRepo(t);
  const eventBus = createEventBus();
  const harvestEvents = collectChannel(eventBus, 'run:harvested');
  const services = makeServices(db, { eventBus });
  const { run, worktreePath } = await createRunInWorktree({ db, repoDir, ...services });
  fs.writeFileSync(path.join(worktreePath, 'agent-output.txt'), 'agent work\n');
  const completed = services.runService.updateRunStatus(run.id, 'completed', { force: true });

  await services.harvestService.harvestRun(completed, { projectDir: repoDir });
  await services.harvestService.harvestRun(completed, { projectDir: repoDir });

  assert.equal(harvestEvents.length, 1);

  const second = await createRunInWorktree({ db, repoDir, ...services });
  const secondCompleted = services.runService.updateRunStatus(second.run.id, 'completed', { force: true });
  services.runService.addRunEvent(second.run.id, 'harvest:error', JSON.stringify({ stage: 'preexisting', error: 'done' }));
  await services.harvestService.harvestRun(secondCompleted, { projectDir: repoDir });

  assert.equal(harvestEvents.length, 1, 'preexisting DB harvest event skips run:harvested emit');
});

test('harvestRun autosaves uncommitted worker changes before diff capture', async (t) => {
  const db = await mkdb(t);
  const repoDir = makeRepo(t);
  const services = makeServices(db);
  const { run, worktreePath, branch } = await createRunInWorktree({ db, repoDir, ...services });
  fs.writeFileSync(path.join(worktreePath, 'agent-output.txt'), 'agent work\n');
  const completed = services.runService.updateRunStatus(run.id, 'completed', { force: true });

  await services.harvestService.harvestRun(completed, { projectDir: repoDir });

  const diffEvents = eventsOf(services.runService, run.id, 'harvest:diff');
  assert.equal(diffEvents.length, 1);
  const payload = parseEvent(diffEvents[0]);
  assert.ok(payload.files.includes('agent-output.txt'), 'diff includes autosaved uncommitted file');
  assert.ok(payload.commits.some(line => line.includes('[palantir] auto-save')), 'commit list includes autosave commit');
  assert.equal(payload.branch, branch);
  assert.ok(!fs.existsSync(worktreePath), 'worktree removed after harvest');
});

test('harvestRun does not commit files created by the test command', async (t) => {
  const db = await mkdb(t);
  const repoDir = makeRepo(t);
  const services = makeServices(db);
  const { run, worktreePath, branch } = await createRunInWorktree({
    db,
    repoDir,
    testCommand: 'write:test-artifact.txt pass',
    ...services,
  });
  fs.writeFileSync(path.join(worktreePath, 'agent-output.txt'), 'agent work\n');
  const completed = services.runService.updateRunStatus(run.id, 'completed', { force: true });

  await services.harvestService.harvestRun(completed, { projectDir: repoDir });

  const testEvents = eventsOf(services.runService, run.id, 'harvest:test');
  assert.equal(testEvents.length, 1);
  assert.equal(parseEvent(testEvents[0]).passed, true);
  const tree = execFileSync('git', ['ls-tree', '-r', '--name-only', branch], {
    cwd: repoDir,
    stdio: 'pipe',
    encoding: 'utf-8',
  });
  assert.match(tree, /agent-output\.txt/);
  assert.doesNotMatch(tree, /test-artifact\.txt/, 'test artifact is discarded instead of committed');
});

test('harvestRun records project node payload when resolver finds declared node', async (t) => {
  const db = await mkdb(t);
  const repoDir = makeRepo(t);
  const binDir = makeFakeNodeBin(t);
  const services = makeServices(db, {
    nodeResolver: (major) => (major === PROJECT_NODE_MAJOR ? binDir : null),
  });
  const { run, worktreePath } = await createRunInWorktree({
    db,
    repoDir,
    testCommand: 'pass',
    ...services,
  });
  fs.writeFileSync(path.join(worktreePath, '.nvmrc'), `${PROJECT_NODE_MAJOR}\n`);
  fs.writeFileSync(path.join(worktreePath, 'agent-output.txt'), 'agent work\n');
  const completed = services.runService.updateRunStatus(run.id, 'completed', { force: true });

  await services.harvestService.harvestRun(completed, { projectDir: repoDir });

  const testPayload = parseEvent(eventsOf(services.runService, run.id, 'harvest:test')[0]);
  assert.equal(testPayload.node_major, PROJECT_NODE_MAJOR);
  assert.equal(testPayload.node_source, 'project');
  assert.equal(eventsOf(services.runService, run.id, 'harvest:error').length, 0);
});

test('harvestRun records fallback node payload and node_unresolved warning', async (t) => {
  const db = await mkdb(t);
  const repoDir = makeRepo(t);
  const services = makeServices(db, { nodeResolver: () => null });
  const { run, worktreePath } = await createRunInWorktree({
    db,
    repoDir,
    testCommand: 'pass',
    ...services,
  });
  fs.writeFileSync(path.join(worktreePath, '.nvmrc'), `${PROJECT_NODE_MAJOR}\n`);
  fs.writeFileSync(path.join(worktreePath, 'agent-output.txt'), 'agent work\n');
  const completed = services.runService.updateRunStatus(run.id, 'completed', { force: true });

  await services.harvestService.harvestRun(completed, { projectDir: repoDir });

  const testPayload = parseEvent(eventsOf(services.runService, run.id, 'harvest:test')[0]);
  assert.equal(testPayload.node_major, PROJECT_NODE_MAJOR);
  assert.equal(testPayload.node_source, 'fallback');
  const errorStages = eventsOf(services.runService, run.id, 'harvest:error').map(evt => parseEvent(evt).stage);
  assert.ok(errorStages.includes('node_unresolved'));
});

test('harvestRun is deduped per run and by existing DB harvest events', async (t) => {
  const db = await mkdb(t);
  const repoDir = makeRepo(t);
  const services = makeServices(db);
  const { run, worktreePath } = await createRunInWorktree({ db, repoDir, ...services });
  fs.writeFileSync(path.join(worktreePath, 'agent-output.txt'), 'agent work\n');
  const completed = services.runService.updateRunStatus(run.id, 'completed', { force: true });

  await services.harvestService.harvestRun(completed, { projectDir: repoDir });
  await services.harvestService.harvestRun(completed, { projectDir: repoDir });

  assert.equal(eventsOf(services.runService, run.id, 'harvest:diff').length, 1);
  assert.equal(eventsOf(services.runService, run.id, 'harvest:error').length, 0);

  const second = await createRunInWorktree({ db, repoDir, ...services });
  const secondCompleted = services.runService.updateRunStatus(second.run.id, 'completed', { force: true });
  services.runService.addRunEvent(second.run.id, 'harvest:error', JSON.stringify({ stage: 'preexisting', error: 'done' }));
  await services.harvestService.harvestRun(secondCompleted, { projectDir: repoDir });
  assert.equal(eventsOf(services.runService, second.run.id, 'harvest:error').length, 1);
  assert.ok(fs.existsSync(second.worktreePath), 'preexisting DB harvest event skips new harvest work');
});

test('harvestRun never throws when stages fail', async (t) => {
  const db = await mkdb(t);
  const repoDir = makeRepo(t);
  const real = makeServices(db);
  const brokenWorktreeService = {
    autoSaveWorktree() { throw new Error('autosave broke'); },
    getWorktreeDiff() { throw new Error('diff broke'); },
    removeWorktree() { throw new Error('cleanup broke'); },
  };
  const harvestService = createHarvestService({
    runService: real.runService,
    worktreeService: brokenWorktreeService,
    projectService: real.projectService,
    testRunner: injectedTestRunner,
  });
  const { run } = await createRunInWorktree({ db, repoDir, ...real });
  const completed = real.runService.updateRunStatus(run.id, 'completed', { force: true });

  await assert.doesNotReject(() => harvestService.harvestRun(completed, { projectDir: repoDir }));

  const stages = eventsOf(real.runService, run.id, 'harvest:error').map(evt => parseEvent(evt).stage);
  assert.ok(stages.includes('autosave'));
  assert.ok(stages.includes('diff'));
  assert.ok(stages.includes('cleanup'));
});

test('harvestRun skips cancelled and manager runs', async (t) => {
  const db = await mkdb(t);
  const repoDir = makeRepo(t);
  const services = makeServices(db);
  const { run, worktreePath, branch } = await createRunInWorktree({ db, repoDir, ...services });
  const cancelled = services.runService.updateRunStatus(run.id, 'cancelled', { force: true });

  await services.harvestService.harvestRun(cancelled, { projectDir: repoDir });
  assert.equal(eventsOf(services.runService, run.id, 'harvest:diff').length, 0);
  assert.ok(fs.existsSync(worktreePath), 'direct service skip leaves cancelled cleanup to lifecycle');

  const manager = services.runService.createRun({
    is_manager: true,
    prompt: 'manage',
    manager_adapter: 'codex',
    manager_layer: 'top',
    conversation_id: 'top',
  });
  await services.harvestService.harvestRun({
    ...manager,
    status: 'completed',
    is_manager: 1,
    worktree_path: worktreePath,
    branch,
  }, { projectDir: repoDir });
  assert.equal(eventsOf(services.runService, manager.id, 'harvest:diff').length, 0);
});

test('harvestRun tolerates DELETE race without throwing', async (t) => {
  const db = await mkdb(t);
  const repoDir = makeRepo(t);
  const services = makeServices(db);
  const { run, worktreePath } = await createRunInWorktree({ db, repoDir, ...services });
  fs.writeFileSync(path.join(worktreePath, 'agent-output.txt'), 'agent work\n');
  const completed = services.runService.updateRunStatus(run.id, 'completed', { force: true });
  services.runService.deleteRun(run.id);

  await assert.doesNotReject(() => services.harvestService.harvestRun(completed, { projectDir: repoDir }));
  assert.ok(!fs.existsSync(worktreePath), 'harvest still performs best-effort cleanup after run deletion');
});

test('harvestRun records timed-out test results', async (t) => {
  const db = await mkdb(t);
  const repoDir = makeRepo(t);
  const services = makeServices(db);
  const { run, worktreePath } = await createRunInWorktree({
    db,
    repoDir,
    testCommand: 'sleep:250 pass',
    ...services,
  });
  fs.writeFileSync(path.join(worktreePath, 'agent-output.txt'), 'agent work\n');
  const completed = services.runService.updateRunStatus(run.id, 'completed', { force: true });
  const prev = process.env.PALANTIR_HARVEST_TEST_TIMEOUT_MS;
  process.env.PALANTIR_HARVEST_TEST_TIMEOUT_MS = '50';
  try {
    await services.harvestService.harvestRun(completed, { projectDir: repoDir });
  } finally {
    if (prev === undefined) delete process.env.PALANTIR_HARVEST_TEST_TIMEOUT_MS;
    else process.env.PALANTIR_HARVEST_TEST_TIMEOUT_MS = prev;
  }

  const payload = parseEvent(eventsOf(services.runService, run.id, 'harvest:test')[0]);
  assert.equal(payload.timed_out, true);
  assert.equal(payload.passed, false);
  assert.equal(payload.exit_code, null);
});

test('failed runs capture diff but skip test execution', async (t) => {
  const db = await mkdb(t);
  const repoDir = makeRepo(t);
  const services = makeServices(db);
  const { run, worktreePath } = await createRunInWorktree({
    db,
    repoDir,
    testCommand: 'write:should-not-exist.txt pass',
    ...services,
  });
  fs.writeFileSync(path.join(worktreePath, 'agent-output.txt'), 'agent work\n');
  const failed = services.runService.updateRunStatus(run.id, 'failed', { force: true });

  await services.harvestService.harvestRun(failed, { projectDir: repoDir });

  assert.equal(eventsOf(services.runService, run.id, 'harvest:diff').length, 1);
  assert.equal(eventsOf(services.runService, run.id, 'harvest:test').length, 0);
});

test('lifecycle run:ended subscriber runs harvest before removing worktree', async (t) => {
  const db = await mkdb(t);
  const repoDir = makeRepo(t);
  const eventBus = createEventBus();
  const realWorktreeService = createWorktreeService();
  const observed = [];
  let runIdForObservation = null;
  const observingWorktreeService = {
    ...realWorktreeService,
    removeWorktree(projectDir, worktreePath, branch, opts) {
      if (runIdForObservation) {
        observed.push(eventsOf(runService, runIdForObservation, 'harvest:diff').length);
      }
      return realWorktreeService.removeWorktree(projectDir, worktreePath, branch, opts);
    },
  };
  const runService = createRunService(db, eventBus);
  const taskService = createTaskService(db);
  const projectService = createProjectService(db);
  const agentProfileService = createAgentProfileService(db);
  const harvestService = createHarvestService({
    runService,
    worktreeService: observingWorktreeService,
    projectService,
    eventBus,
    testRunner: injectedTestRunner,
  });
  const lifecycleService = createLifecycleService({
    runService,
    taskService,
    agentProfileService,
    projectService,
    executionEngine: { type: 'subprocess', discoverGhostSessions: () => [] },
    streamJsonEngine: null,
    worktreeService: observingWorktreeService,
    harvestService,
    eventBus,
  });
  t.after(() => lifecycleService.stopMonitoring());

  const { run, worktreePath } = await createRunInWorktree({
    db,
    runService,
    taskService,
    projectService,
    worktreeService: observingWorktreeService,
    repoDir,
  });
  runIdForObservation = run.id;
  fs.writeFileSync(path.join(worktreePath, 'agent-output.txt'), 'agent work\n');
  lifecycleService.startMonitoring();
  runService.updateRunStatus(run.id, 'completed', { force: true });

  await waitFor(() => eventsOf(runService, run.id, 'harvest:diff').length === 1 && !fs.existsSync(worktreePath));
  assert.ok(observed.some(count => count > 0), 'removeWorktree observed harvest:diff already recorded');
});

test('lifecycle run:ended subscriber emits harvested=false for completed worker without worktree', async (t) => {
  const db = await mkdb(t);
  const repoDir = makeRepo(t);
  const eventBus = createEventBus();
  const harvestEvents = collectChannel(eventBus, 'run:harvested');
  const services = makeServices(db, { eventBus });
  const lifecycleService = createLifecycleService({
    runService: services.runService,
    taskService: services.taskService,
    agentProfileService: services.agentProfileService,
    projectService: services.projectService,
    executionEngine: { type: 'subprocess', discoverGhostSessions: () => [] },
    streamJsonEngine: null,
    worktreeService: services.worktreeService,
    harvestService: services.harvestService,
    eventBus,
  });
  t.after(() => lifecycleService.stopMonitoring());

  const { run } = createRunWithoutWorktree({ db, repoDir, ...services });
  lifecycleService.startMonitoring();
  services.runService.updateRunStatus(run.id, 'completed', { force: true });

  await waitFor(() => harvestEvents.length === 1);
  assert.equal(harvestEvents[0].data.run.id, run.id);
  assert.deepEqual(harvestEvents[0].data.summary.errors, ['no_worktree']);
  assert.equal(harvestEvents[0].data.summary.harvested, false);
});

test('lifecycle run:ended subscriber calls harvest when projectDir resolution fails', async (t) => {
  const db = await mkdb(t);
  const repoDir = makeRepo(t);
  const eventBus = createEventBus();
  const harvestEvents = collectChannel(eventBus, 'run:harvested');
  const services = makeServices(db, { eventBus });
  const lifecycleService = createLifecycleService({
    runService: services.runService,
    taskService: services.taskService,
    agentProfileService: services.agentProfileService,
    projectService: services.projectService,
    executionEngine: { type: 'subprocess', discoverGhostSessions: () => [] },
    streamJsonEngine: null,
    worktreeService: services.worktreeService,
    harvestService: services.harvestService,
    eventBus,
  });
  t.after(() => lifecycleService.stopMonitoring());

  const { run } = await createRunWithMissingProjectDir({ db, repoDir, ...services });
  lifecycleService.startMonitoring();
  services.runService.updateRunStatus(run.id, 'completed', { force: true });

  await waitFor(() => harvestEvents.length === 1);
  assert.equal(harvestEvents[0].data.run.id, run.id);
  assert.deepEqual(harvestEvents[0].data.summary.errors, ['no_project_dir']);
  assert.equal(harvestEvents[0].data.summary.harvested, false);
});

test('PM auto-review sends one message from run:harvested with harvest summary', () => {
  const harness = makeAutoReviewHarness();

  harness.eventBus.emit('run:harvested', {
    run: reviewRun(),
    summary: harvestedSummary(),
  });

  assert.equal(harness.sent.length, 1);
  assert.equal(harness.sent[0].slot, conversationIdForProject('proj_1')); // Phase 2: operator:proj_1
  const text = harness.sent[0].message.text;
  assert.match(text, /Worker run run_worker_1 finished/);
  assert.match(text, /\[harvest\] files: 2, commits: 1/);
  assert.match(text, /\[harvest\] test: PASS \(exit 0, 123ms\)/);
  assert.match(text, /a\.js \| 1 \+/);
  assert.match(text, /tests passed/);
});

test('W-P4: PM auto-review sends attributed worker review to that instance primary legacy slot only', () => {
  const harness = makeAutoReviewHarness();

  harness.eventBus.emit('run:harvested', {
    run: reviewRun({
      operator_instance_id: 'oi_proj_2',
      project_id: 'proj_1',
    }),
    summary: harvestedSummary(),
  });

  assert.equal(harness.sent.length, 1);
  assert.equal(harness.sent[0].slot, conversationIdForProject('proj_2'));
  assert.equal(harness.controller.autoReviewCounts.get('oi_proj_2:task_1'), 1);
  assert.equal(harness.controller.autoReviewCounts.get('oi_proj_1:task_1'), undefined);
});

test('W-P4: PM auto-review uses primary instance for unattributed run and Top when none exists', () => {
  const harness = makeAutoReviewHarness();

  harness.eventBus.emit('run:harvested', {
    run: reviewRun({ id: 'run_primary_receiver' }),
    summary: harvestedSummary(),
  });
  harness.eventBus.emit('run:harvested', {
    run: reviewRun({
      id: 'run_top_receiver',
      project_id: 'proj_orphan',
    }),
    summary: harvestedSummary(),
  });

  assert.equal(harness.sent.length, 2);
  assert.equal(harness.sent[0].slot, conversationIdForProject('proj_1'));
  assert.equal(harness.sent[1].slot, 'top');
  assert.equal(harness.controller.autoReviewCounts.get('oi_proj_1:task_1'), 1);
  assert.equal(harness.controller.autoReviewCounts.get('project:proj_orphan:task_1'), 1);
});

test('W-P4: PM auto-review falls back to Top when attributed instance has no primary', () => {
  const harness = makeAutoReviewHarness();

  harness.eventBus.emit('run:harvested', {
    run: reviewRun({
      operator_instance_id: 'oi_no_primary',
      project_id: 'proj_1',
    }),
    summary: harvestedSummary(),
  });

  assert.equal(harness.sent.length, 1);
  assert.equal(harness.sent[0].slot, 'top');
  assert.equal(harness.controller.autoReviewCounts.get('oi_no_primary:task_1'), 1);
  assert.equal(harness.controller.autoReviewCounts.get('oi_proj_1:task_1'), undefined);
});

test('PM auto-review ignores run:completed so review is single-triggered by run:harvested', () => {
  const harness = makeAutoReviewHarness();

  harness.eventBus.emit('run:completed', {
    run: reviewRun(),
  });

  assert.equal(harness.sent.length, 0);
});

test('PM auto-review suppresses failed run while higher retry attempt is active', () => {
  const failed = reviewRun({ status: 'failed', retry_count: 0 });
  const harness = makeAutoReviewHarness({
    runServiceRuns: [
      reviewRun({ id: 'run_retry_1', status: 'queued', retry_count: 1, retry_root_run_id: failed.id }),
    ],
  });

  harness.eventBus.emit('run:harvested', {
    run: failed,
    summary: harvestedSummary(),
  });

  assert.deepEqual(harness.listRunsCalls, [{ task_id: 'task_1' }]);
  assert.equal(harness.sent.length, 0);
  assert.equal(harness.controller.autoReviewCounts.get('oi_proj_1:task_1') || 0, 0);
  assert.equal(harness.runEvents.length, 1);
  assert.deepEqual(harness.runEvents[0], {
    runId: failed.id,
    eventType: 'pm_review:suppressed',
    payloadJson: JSON.stringify({
      reason: 'retry_pending',
      retry_root_run_id: failed.id,
      receiver_instance_id: 'oi_proj_1',
      receiver_slot: conversationIdForProject('proj_1'),
    }),
  });
});

test('W-P4: PM auto-review does not suppress failed run for higher retry in a different root', () => {
  const failed = reviewRun({
    id: 'run_root_a',
    status: 'failed',
    retry_count: 0,
    retry_root_run_id: 'root_a',
  });
  const harness = makeAutoReviewHarness({
    runServiceRuns: [
      reviewRun({
        id: 'run_root_b_retry',
        status: 'queued',
        retry_count: 1,
        retry_root_run_id: 'root_b',
      }),
    ],
  });

  harness.eventBus.emit('run:harvested', {
    run: failed,
    summary: harvestedSummary(),
  });

  assert.equal(harness.sent.length, 1);
  assert.equal(harness.runEvents.length, 0);
  assert.equal(harness.controller.autoReviewCounts.get('oi_proj_1:task_1'), 1);
});

test('PM auto-review sends final retry failure when no higher retry attempt is active', () => {
  const harness = makeAutoReviewHarness();

  harness.eventBus.emit('run:harvested', {
    run: reviewRun({ status: 'failed', retry_count: 1 }),
    summary: harvestedSummary(),
  });

  assert.equal(harness.sent.length, 1);
  assert.equal(harness.runEvents.length, 0);
  assert.equal(harness.controller.autoReviewCounts.get('oi_proj_1:task_1'), 1);
  assert.match(harness.sent[0].message.text, /status: failed/);
});

test('PM auto-review sends completed run even when higher retry attempt is active', () => {
  const harness = makeAutoReviewHarness({
    runServiceRuns: [
      reviewRun({ id: 'run_retry_1', status: 'running', retry_count: 1 }),
    ],
  });

  harness.eventBus.emit('run:harvested', {
    run: reviewRun({ status: 'completed', retry_count: 0 }),
    summary: harvestedSummary(),
  });

  assert.equal(harness.sent.length, 1);
  assert.equal(harness.runEvents.length, 0);
  assert.equal(harness.listRunsCalls.length, 0);
});

test('PM auto-review sends failed run for same retry_count active attempt', () => {
  const harness = makeAutoReviewHarness({
    runServiceRuns: [
      reviewRun({ id: 'run_peer_same_retry', status: 'running', retry_count: 0 }),
    ],
  });

  harness.eventBus.emit('run:harvested', {
    run: reviewRun({ status: 'failed', retry_count: 0 }),
    summary: harvestedSummary(),
  });

  assert.equal(harness.sent.length, 1);
  assert.equal(harness.runEvents.length, 0);
  assert.equal(harness.controller.autoReviewCounts.get('oi_proj_1:task_1'), 1);
});

test('PM auto-review sends failed run when no active retry attempt exists', () => {
  const harness = makeAutoReviewHarness({
    runServiceRuns: [
      reviewRun({ id: 'run_old_completed', status: 'completed', retry_count: 1 }),
    ],
  });

  harness.eventBus.emit('run:harvested', {
    run: reviewRun({ status: 'failed', retry_count: 0 }),
    summary: harvestedSummary(),
  });

  assert.equal(harness.sent.length, 1);
  assert.equal(harness.runEvents.length, 0);
});

test('PM auto-review sends failed run when listRuns throws', () => {
  const harness = makeAutoReviewHarness({
    listRunsImpl() {
      throw new Error('list failed');
    },
  });

  harness.eventBus.emit('run:harvested', {
    run: reviewRun({ status: 'failed', retry_count: 0 }),
    summary: harvestedSummary(),
  });

  assert.equal(harness.sent.length, 1);
  assert.equal(harness.runEvents.length, 0);
  assert.equal(harness.controller.autoReviewCounts.get('oi_proj_1:task_1'), 1);
});

test('PM auto-review keeps suppression when suppressed event recording throws', () => {
  const failed = reviewRun({ status: 'failed', retry_count: 0 });
  const harness = makeAutoReviewHarness({
    runServiceRuns: [
      reviewRun({ id: 'run_retry_1', status: 'queued', retry_count: 1, retry_root_run_id: failed.id }),
    ],
    addRunEventImpl() {
      throw new Error('event write failed');
    },
  });

  const accepted = harness.controller.sendPmReview({
    run: failed,
    harvestSummary: harvestedSummary(),
  });

  assert.equal(accepted, false);
  assert.equal(harness.sent.length, 0);
  assert.equal(harness.controller.autoReviewCounts.get('oi_proj_1:task_1') || 0, 0);
});

test('PM auto-review sends failed run when runService is not injected', () => {
  const harness = makeAutoReviewHarness({ injectRunService: false });

  harness.eventBus.emit('run:harvested', {
    run: reviewRun({ status: 'failed', retry_count: 0 }),
    summary: harvestedSummary(),
  });

  assert.equal(harness.sent.length, 1);
  assert.equal(harness.controller.autoReviewCounts.get('project:proj_1:task_1'), 1);
});

test('PM auto-review circuit breaker caps review sends at five and resets on PM clear', () => {
  const harness = makeAutoReviewHarness();

  for (let i = 0; i < 6; i++) {
    harness.eventBus.emit('run:harvested', {
      run: reviewRun({ id: `run_worker_${i}` }),
      summary: harvestedSummary(),
    });
  }

  assert.equal(harness.sent.length, 5);
  assert.equal(harness.warnings.length, 1);

  harness.slotClearedCallbacks[0]({ conversationId: 'operator:proj_1' });
  harness.eventBus.emit('run:harvested', {
    run: reviewRun({ id: 'run_worker_after_reset' }),
    summary: harvestedSummary(),
  });

  assert.equal(harness.sent.length, 6);
  assert.match(harness.sent[5].message.text, /Review round 1\/5/);
});

test('W-P4: PM auto-review circuit breaker counts per receiver instance', () => {
  const harness = makeAutoReviewHarness({ autoReviewMax: 2 });

  for (let i = 0; i < 3; i++) {
    harness.eventBus.emit('run:harvested', {
      run: reviewRun({ id: `run_receiver_one_${i}`, operator_instance_id: 'oi_proj_1' }),
      summary: harvestedSummary(),
    });
  }
  harness.eventBus.emit('run:harvested', {
    run: reviewRun({ id: 'run_receiver_two', operator_instance_id: 'oi_proj_2' }),
    summary: harvestedSummary(),
  });

  assert.equal(harness.sent.length, 3);
  assert.equal(harness.warnings.length, 1);
  assert.equal(harness.controller.autoReviewCounts.get('oi_proj_1:task_1'), 2);
  assert.equal(harness.controller.autoReviewCounts.get('oi_proj_2:task_1'), 1);
});

test('PM auto-review skips when project has no active PM', () => {
  const harness = makeAutoReviewHarness({ activeRunId: null });

  harness.eventBus.emit('run:harvested', {
    run: reviewRun(),
    summary: harvestedSummary(),
  });

  assert.equal(harness.sent.length, 0);
});

test('W-P4 R1: Top slot clear resets Top-fallback breaker counts (orphan project)', () => {
  // Codex W-P4 review: Top-fallback counts are keyed "project:<id>:<task>" but
  // their SLOT is 'top' — operator-based resets can never reach them, so a
  // cleared/replaced Top would leave the breaker permanently tripped.
  const harness = makeAutoReviewHarness({ autoReviewMax: 1 });

  const emitOrphan = (id) => harness.eventBus.emit('run:harvested', {
    run: reviewRun({ id, project_id: 'proj_orphan' }),
    summary: harvestedSummary(),
  });

  emitOrphan('run_top_1');
  emitOrphan('run_top_2'); // breaker trips (max 1)
  assert.equal(harness.sent.length, 1);
  assert.equal(harness.sent[0].slot, 'top');
  assert.equal(harness.warnings.length, 1);

  harness.slotClearedCallbacks[0]({ conversationId: 'top' });
  emitOrphan('run_top_3');
  assert.equal(harness.sent.length, 2, 'Top clear must reset Top-fallback breaker counts');
});

test('PM auto-review reserves breaker slot synchronously so a burst cannot exceed the cap', () => {
  // defer is held (not run) to simulate many run:harvested events landing
  // before any deferred send executes — the race the reserve-then-send fix
  // closes. Without synchronous reservation, all 6 would read a stale count
  // of 0 and slip past the breaker.
  const pending = [];
  const harness = makeAutoReviewHarness({ defer: (fn) => pending.push(fn) });

  const accepted = [];
  for (let i = 0; i < 6; i++) {
    accepted.push(harness.controller.sendPmReview({
      run: reviewRun({ id: `run_burst_${i}` }),
      harvestSummary: null,
    }));
  }

  // 5 reserved synchronously, 6th hit the breaker BEFORE any send ran.
  assert.equal(accepted.filter(Boolean).length, 5);
  assert.equal(accepted[5], false);
  assert.equal(harness.controller.autoReviewCounts.get('oi_proj_1:task_1'), 5);
  assert.equal(harness.sent.length, 0, 'sends are still deferred');

  pending.forEach((fn) => fn());
  assert.equal(harness.sent.length, 5);
});

test('PM auto-review preserves counter rollback when sendMessage fails', () => {
  const harness = makeAutoReviewHarness({ throwOnSend: true });

  harness.eventBus.emit('run:harvested', {
    run: reviewRun({ id: 'run_worker_failed_send' }),
    summary: harvestedSummary(),
  });
  assert.equal(harness.sent.length, 0);
  assert.equal(harness.controller.autoReviewCounts.get('oi_proj_1:task_1'), undefined);

  harness.setThrowOnSend(false);
  harness.eventBus.emit('run:harvested', {
    run: reviewRun({ id: 'run_worker_retry' }),
    summary: harvestedSummary(),
  });

  assert.equal(harness.sent.length, 1);
  assert.match(harness.sent[0].message.text, /Review round 1\/5/);
});

test('PM auto-review caps harvest text and reports harvested=false reasons', () => {
  const harness = makeAutoReviewHarness();
  const longText = 'x'.repeat(700);

  harness.eventBus.emit('run:harvested', {
    run: reviewRun(),
    summary: harvestedSummary({
      statText: longText,
      test: {
        passed: false,
        timed_out: true,
        exit_code: null,
        duration_ms: 456,
        output_tail: longText,
      },
    }),
  });

  const cappedText = harness.sent[0].message.text;
  assert.ok(cappedText.includes('x'.repeat(500)));
  assert.ok(!cappedText.includes('x'.repeat(501)));
  assert.match(cappedText, /\[harvest\] test: TIMEOUT \(exit \?, 456ms\)/);

  const unavailable = makeAutoReviewHarness();
  unavailable.eventBus.emit('run:harvested', {
    run: reviewRun(),
    summary: harvestedSummary({
      files: 0,
      commits: 0,
      statText: '',
      test: null,
      errors: ['no_worktree'],
      harvested: false,
    }),
  });

  assert.equal(unavailable.sent.length, 1);
  assert.match(unavailable.sent[0].message.text, /\[harvest\] 수집 불가 \(no_worktree\)/);
});

test('boot stale terminal worktree cleanup autosaves remaining work', async (t) => {
  const db = await mkdb(t);
  const repoDir = makeRepo(t);
  const services = makeServices(db);
  const { run, worktreePath, branch } = await createRunInWorktree({ db, repoDir, ...services });
  fs.writeFileSync(path.join(worktreePath, 'boot-leftover.txt'), 'leftover work\n');
  services.runService.updateRunStatus(run.id, 'completed', { force: true });
  const lifecycleService = createLifecycleService({
    runService: services.runService,
    taskService: services.taskService,
    agentProfileService: services.agentProfileService,
    projectService: services.projectService,
    executionEngine: { type: 'subprocess', discoverGhostSessions: () => [] },
    streamJsonEngine: null,
    worktreeService: services.worktreeService,
    harvestService: services.harvestService,
    eventBus: null,
  });

  const cleaned = await lifecycleService.cleanupStaleTerminalWorktrees();

  assert.equal(cleaned, 1);
  assert.ok(!fs.existsSync(worktreePath), 'stale worktree removed');
  const tree = execFileSync('git', ['ls-tree', '-r', '--name-only', branch], {
    cwd: repoDir,
    stdio: 'pipe',
    encoding: 'utf-8',
  });
  assert.match(tree, /boot-leftover\.txt/, 'boot cleanup preserves uncommitted work via autosave');
});
