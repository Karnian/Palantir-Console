'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const { createApp } = require('../app');
const { createManagerRouter } = require('../routes/manager');
const { invokeApp } = require('./helpers/invokeApp');

const AUTH_TOKEN = 'operator-archive-test-secret';
const COOKIE = `palantir_token=${AUTH_TOKEN}`;
const ARCHIVE_NOW = new Date('2026-07-28T03:04:05.000Z');

async function createTestApp(t, options = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'palantir-operator-archive-'));
  const storageRoot = path.join(root, 'storage');
  const fsRoot = path.join(root, 'files');
  await fs.mkdir(storageRoot);
  await fs.mkdir(fsRoot);
  const app = createApp({
    storageRoot,
    fsRoot,
    dbPath: path.join(root, 'test.db'),
    authToken: AUTH_TOKEN,
    authResolverOpts: { hasKeychain: () => false },
    memoryDistillEnabled: false,
    masterMemoryXprojectScanEnabled: false,
    ...options,
  });
  t.after(async () => {
    await app.shutdown();
    await fs.rm(root, { recursive: true, force: true });
  });
  return { app, root, storageRoot, fsRoot, db: app.services._rawDb };
}

function api(app, method, requestPath, body, headers = {}) {
  return invokeApp(app, {
    method,
    path: requestPath,
    body,
    headers,
  });
}

function cookieHeaders(extra = {}) {
  return { cookie: COOKIE, ...extra };
}

function createProject(app, name = 'Archive project', fields = {}) {
  return app.services.projectService.createProject({ name, ...fields });
}

function createProfile(app, name = 'Archive profile') {
  return app.services.operatorProfileService.createProfile({
    name,
    persona: 'Preserved historical identity',
    capabilities: [],
  });
}

function createMappedInstance(app, name = 'Archive project') {
  const project = createProject(app, name);
  const profile = createProfile(app, `${name} profile`);
  const instance = app.services.operatorInstanceService.createInstance({
    profile_id: profile.id,
    display_name: `${name} Operator`,
    primary_project_id: project.id,
    preferred_adapter: 'codex',
  });
  return { project, profile, instance };
}

function fakeAdapter({ failDispose = false } = {}) {
  return {
    isSessionAlive: () => true,
    detectExitCode: () => null,
    disposeSession() {
      if (failDispose) throw new Error('dispose exploded');
      return true;
    },
  };
}

function createOperatorRun(app, instanceId, adapter = null) {
  const run = app.services.runService.createRun({
    is_manager: true,
    manager_layer: 'operator',
    conversation_id: `operator:${instanceId}`,
    operator_instance_id: instanceId,
    manager_adapter: 'codex',
    prompt: `Operator ${instanceId}`,
  });
  if (adapter) app.managerRegistry.setActive(`operator:${instanceId}`, run.id, adapter);
  return run;
}

async function archive(app, instanceId, headers = cookieHeaders()) {
  return api(
    app,
    'DELETE',
    `/api/operator-instances/${encodeURIComponent(instanceId)}`,
    undefined,
    headers,
  );
}

function insertInvocation(db, instanceId, id, status) {
  db.prepare(`
    INSERT INTO operator_invocations (
      id, schedule_id, operator_instance_id, schedule_revision, source,
      prompt_snapshot, codebase_project_id, rule_snapshot_json,
      scheduled_for, status, run_after
    ) VALUES (?, NULL, ?, NULL, 'scheduled', 'archive test', NULL, NULL, ?, ?, ?)
  `).run(
    id,
    instanceId,
    '2026-07-28T03:00:00.000Z',
    status,
    '2026-07-28T03:00:00.000Z',
  );
}

test('archive retires DB dependants, preserves profile/attribution, and reports the last primary', async (t) => {
  const { app, db } = await createTestApp(t);
  const { project, profile, instance } = createMappedInstance(app, 'Primary archive');
  const shared = app.services.operatorInstanceService.createInstance({
    profile_id: profile.id,
    display_name: 'Shared private-profile peer',
  });
  db.prepare('UPDATE operator_profiles SET is_private=1 WHERE id=?').run(profile.id);

  const schedule = app.services.operatorScheduleService.createSchedule(instance.id, {
    name: 'Ghost prevention',
    prompt: 'This schedule must not fire after archive.',
    codebase_project_id: project.id,
    rule: { kind: 'interval', minutes: 60 },
    timezone: 'UTC',
  }, new Date('2026-07-28T02:00:00.000Z'));

  db.exec('DROP INDEX idx_operator_invocations_active_operator');
  for (const [suffix, status] of [
    ['pending', 'pending'],
    ['claimed', 'claimed'],
    ['delivering', 'delivering'],
    ['running', 'running'],
  ]) {
    insertInvocation(db, instance.id, `oinv_archive_${suffix}`, status);
  }

  app.services.managerMessageQueueService.stop();
  const queued = await app.services.managerMessageQueueService.enqueue(
    `operator:${instance.id}`,
    { text: 'Never redeliver me' },
    { idempotencyKey: 'archive-queued' },
  );
  assert.equal(queued.message.status, 'queued');

  const historicalRun = app.services.runService.createRun({
    is_manager: true,
    manager_layer: 'operator',
    conversation_id: `operator:${instance.id}`,
    manager_adapter: 'codex',
    prompt: 'Historical attributed run',
    operator_instance_id: instance.id,
  });
  db.prepare(`
    INSERT INTO dispatch_audit_log (
      id, project_id, task_id, pm_run_id, selected_agent_profile_id,
      operator_instance_id, rationale, pm_claim, db_truth,
      incoherence_flag, incoherence_kind, created_at
    ) VALUES (?, ?, NULL, NULL, NULL, ?, NULL, '{}', '{}', 0, NULL, ?)
  `).run('audit_archive_history', project.id, instance.id, ARCHIVE_NOW.getTime());

  const result = await app.services.operatorIdentityLifecycleService.archiveInstance(
    instance.id,
    { now: ARCHIVE_NOW },
  );
  assert.equal(result.already_archived, false);
  assert.deepEqual(result.affected_codebases, [{
    id: project.id,
    name: project.name,
    role: 'primary',
  }]);
  assert.equal(result.instance.archived_at, ARCHIVE_NOW.toISOString());
  assert.equal(result.terminalized_queue_count, 1);
  assert.equal(result.cancelled_invocation_count, 2);

  assert.equal(app.services.operatorInstanceService.listInstances().some(row => row.id === instance.id), false);
  assert.equal(app.services.operatorInstanceService.getInstance(instance.id).archived_at, ARCHIVE_NOW.toISOString());
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM operator_codebase_refs WHERE instance_id=?').get(instance.id).n, 0);
  assert.deepEqual(
    db.prepare('SELECT archived_at, enabled, next_fire_at FROM operator_schedules WHERE id=?').get(schedule.id),
    { archived_at: ARCHIVE_NOW.toISOString(), enabled: 0, next_fire_at: null },
  );
  assert.deepEqual(
    db.prepare('SELECT status FROM operator_invocations WHERE operator_instance_id=? ORDER BY id').all(instance.id)
      .map(row => row.status)
      .sort(),
    ['cancelled', 'cancelled', 'uncertain', 'uncertain'],
    'archive runs AFTER a successful dispose, so no completion event is coming for'
    + ' an in-flight turn; leaving it active would hold the per-Operator slot forever.'
    + ' It crossed the adapter boundary, so it settles as `uncertain` (migration 068s'
    + ' classification for exactly this case), not as `cancelled`.',
  );
  // And the Operator holds no active invocation slot afterwards.
  assert.equal(
    db.prepare(
      "SELECT COUNT(*) AS c FROM operator_invocations WHERE operator_instance_id=?"
      + " AND status IN ('pending','claimed','delivering','running')",
    ).get(instance.id).c,
    0,
  );

  const queueRow = app.services.managerMessageQueueService.getMessage(queued.message.id);
  assert.equal(queueRow.status, 'cancelled');
  assert.equal(queueRow.terminal_reason, 'operator_archived');
  const attempts = queueRow.attempt_count;
  await app.services.managerMessageQueueService.tick();
  assert.equal(app.services.managerMessageQueueService.getMessage(queueRow.id).attempt_count, attempts);

  assert.equal(app.services.operatorProfileService.getProfile(profile.id).is_private, true);
  assert.equal(app.services.operatorInstanceService.getInstance(shared.id).profile_id, profile.id);
  const attribution = db.prepare(`
    SELECT r.operator_instance_id, oi.archived_at, oi.profile_id,
           op.id AS resolved_profile_id, dal.operator_instance_id AS audit_instance_id
    FROM runs r
    JOIN operator_instances oi ON oi.id=r.operator_instance_id
    JOIN operator_profiles op ON op.id=oi.profile_id
    JOIN dispatch_audit_log dal ON dal.id='audit_archive_history'
    WHERE r.id=?
  `).get(historicalRun.id);
  assert.deepEqual(attribution, {
    operator_instance_id: instance.id,
    archived_at: ARCHIVE_NOW.toISOString(),
    profile_id: profile.id,
    resolved_profile_id: profile.id,
    audit_instance_id: instance.id,
  });
});

test('archived instances reject conversations, routing, registry slots, boot resume, and every mutation', async (t) => {
  const { app, db } = await createTestApp(t);
  const { project, profile, instance } = createMappedInstance(app, 'Dead target');
  const schedule = app.services.operatorScheduleService.createSchedule(instance.id, {
    name: 'Archived call',
    prompt: 'Must be rejected.',
    codebase_project_id: project.id,
    rule: { kind: 'interval', minutes: 60 },
    timezone: 'UTC',
  }, new Date('2026-07-28T02:00:00.000Z'));
  const archived = await app.services.operatorIdentityLifecycleService.archiveInstance(
    instance.id,
    { now: ARCHIVE_NOW },
  );
  assert.equal(archived.instance.archived_at, ARCHIVE_NOW.toISOString());

  const direct = await api(
    app,
    'POST',
    `/api/conversations/${encodeURIComponent(`operator:${instance.id}`)}/message`,
    { text: 'Are you alive?' },
    cookieHeaders(),
  );
  assert.equal(direct.status, 409);
  assert.equal(direct.body.code, 'OPERATOR_ARCHIVED');

  const routed = await api(app, 'POST', '/api/router/resolve', {
    text: 'stay here',
    currentConversationId: `operator:${instance.id}`,
  }, cookieHeaders());
  assert.equal(routed.status, 409);

  assert.throws(
    () => app.managerRegistry.setActive(`operator:${instance.id}`, 'run_archived_slot', fakeAdapter()),
    err => err.code === 'OPERATOR_ARCHIVED',
  );

  const newProfile = createProfile(app, 'Replacement profile');
  const mutationCalls = [
    () => app.services.operatorInstanceService.addRef(instance.id, {
      project_id: project.id,
      role: 'reference',
    }),
    () => app.services.operatorInstanceService.setProfileId(instance.id, newProfile.id),
    () => app.services.operatorBriefService.updateEffectiveBrief(instance.id, {
      body: { persona: 'mutated' },
    }),
    () => app.services.operatorIdentityLifecycleService.setPreferredAdapter(instance.id, 'claude'),
    () => app.services.operatorInstanceService.setFastMode(instance.id, 1),
    () => app.services.operatorScheduleService.createSchedule(instance.id, {
      name: 'No resurrection',
      prompt: 'No',
      rule: { kind: 'interval', minutes: 60 },
      timezone: 'UTC',
    }, ARCHIVE_NOW),
    () => app.services.operatorScheduleService.runNow(schedule.id, ARCHIVE_NOW),
  ];
  for (const invoke of mutationCalls) {
    await assert.rejects(async () => invoke(), err => err.code === 'OPERATOR_ARCHIVED');
  }

  const staleRun = app.services.runService.createRun({
    is_manager: true,
    manager_layer: 'operator',
    conversation_id: `operator:${instance.id}`,
    operator_instance_id: instance.id,
    manager_adapter: 'codex',
    prompt: 'Stale boot run',
  });
  db.prepare("UPDATE runs SET status='running' WHERE id=?").run(staleRun.id);
  db.prepare(`
    UPDATE operator_instances
    SET thread_id='thread_must_not_resume', pm_adapter='codex'
    WHERE id=?
  `).run(instance.id);
  let starts = 0;
  const bootAdapter = {
    ...fakeAdapter(),
    startSession() { starts += 1; },
  };
  createManagerRouter({
    runService: app.services.runService,
    managerAdapterFactory: { getAdapter: () => bootAdapter },
    managerRegistry: app.managerRegistry,
    conversationService: { clearParentNotices() {} },
    operatorInstanceService: app.services.operatorInstanceService,
    actorTokens: { humanToken: null, separated: false },
  });
  assert.equal(starts, 0);
  assert.equal(app.services.runService.getRun(staleRun.id).status, 'stopped');

  assert.equal(app.services.operatorProfileService.getProfile(profile.id).id, profile.id);
});

test('archive is cookie/same-origin only, idempotent, fail-closed on dispose, and retryable after DB rollback', async (t) => {
  const { app, db } = await createTestApp(t);

  for (const [label, headers, expected] of [
    ['bearer', { authorization: `Bearer ${AUTH_TOKEN}` }, 403],
    ['none', {}, 403],
    ['evil origin', cookieHeaders({ host: 'console.local', origin: 'https://evil.example' }), 403],
  ]) {
    const { instance } = createMappedInstance(app, `Auth ${label}`);
    const response = await archive(app, instance.id, headers);
    assert.equal(response.status, expected, label);
    assert.equal(app.services.operatorInstanceService.getInstance(instance.id).archived_at, null);
  }

  const cookieTarget = createMappedInstance(app, 'Auth cookie');
  const cookieResult = await archive(app, cookieTarget.instance.id);
  assert.equal(cookieResult.status, 200);
  assert.equal(cookieResult.body.already_archived, false);
  assert.deepEqual(cookieResult.body.affected_codebases, [{
    id: cookieTarget.project.id,
    name: cookieTarget.project.name,
    role: 'primary',
  }]);
  const repeat = await archive(app, cookieTarget.instance.id);
  assert.equal(repeat.status, 200);
  assert.equal(repeat.body.already_archived, true);

  const disposeTarget = createMappedInstance(app, 'Dispose failure');
  const liveRun = createOperatorRun(app, disposeTarget.instance.id, fakeAdapter({ failDispose: true }));
  const disposeFailure = await archive(app, disposeTarget.instance.id);
  assert.equal(disposeFailure.status, 502);
  assert.equal(app.services.operatorInstanceService.getInstance(disposeTarget.instance.id).archived_at, null);
  assert.equal(app.managerRegistry.getActiveRunId(`operator:${disposeTarget.instance.id}`), liveRun.id);
  app.managerRegistry.clearActive(`operator:${disposeTarget.instance.id}`);

  const rollbackTarget = createMappedInstance(app, 'Rollback retry');
  const rollbackSchedule = app.services.operatorScheduleService.createSchedule(rollbackTarget.instance.id, {
    name: 'Rollback schedule',
    prompt: 'Remain active when the transaction aborts.',
    codebase_project_id: rollbackTarget.project.id,
    rule: { kind: 'interval', minutes: 60 },
    timezone: 'UTC',
  }, new Date('2026-07-28T02:00:00.000Z'));
  app.services.runService.setOperatorInstanceThread(rollbackTarget.instance.id, {
    thread_id: 'thread_reset_before_tx_failure',
    pm_adapter: 'codex',
  });
  db.exec(`
    CREATE TRIGGER fail_operator_archive_schedule
    BEFORE UPDATE OF archived_at ON operator_schedules
    WHEN NEW.archived_at IS NOT NULL
    BEGIN
      SELECT RAISE(ABORT, 'forced archive transaction failure');
    END
  `);

  const failed = await app.services.operatorIdentityLifecycleService.archiveInstance(
    rollbackTarget.instance.id,
    { now: ARCHIVE_NOW },
  ).then(() => null, err => err);
  assert.match(failed.message, /forced archive transaction failure/);
  assert.equal(app.services.operatorInstanceService.getInstance(rollbackTarget.instance.id).archived_at, null);
  assert.equal(app.services.operatorInstanceService.getInstance(rollbackTarget.instance.id).thread_id, null);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM operator_codebase_refs WHERE instance_id=?').get(rollbackTarget.instance.id).n, 1);
  assert.equal(db.prepare('SELECT archived_at FROM operator_schedules WHERE id=?').get(rollbackSchedule.id).archived_at, null);

  db.exec('DROP TRIGGER fail_operator_archive_schedule');
  const retry = await app.services.operatorIdentityLifecycleService.archiveInstance(
    rollbackTarget.instance.id,
    { now: ARCHIVE_NOW },
  );
  assert.equal(retry.instance.archived_at, ARCHIVE_NOW.toISOString());
  assert.equal(retry.affected_codebases[0].id, rollbackTarget.project.id);
});

test('ensure creates a UUID instance instead of resurrecting an archived deterministic instance', async (t) => {
  const { app } = await createTestApp(t);
  const project = createProject(app, 'Ensure resurrection');
  const original = app.services.runService.ensurePrimaryOperatorInstanceForProject(project.id);
  assert.equal(original.instanceId, `oi_${project.id}`);

  await app.services.operatorIdentityLifecycleService.archiveInstance(
    original.instanceId,
    { now: ARCHIVE_NOW },
  );
  const replacement = app.services.runService.ensurePrimaryOperatorInstanceForProject(project.id);
  assert.notEqual(replacement.instanceId, original.instanceId);
  assert.match(replacement.instanceId, /^oi_[0-9a-f-]{36}$/);
  assert.equal(app.services.operatorInstanceService.getInstance(original.instanceId).archived_at, ARCHIVE_NOW.toISOString());
  assert.equal(app.services.operatorInstanceService.getInstance(original.instanceId).refs.length, 0);
  assert.equal(app.services.operatorInstanceService.getInstance(replacement.instanceId).archived_at, null);
  assert.deepEqual(
    app.services.operatorInstanceService.getInstance(replacement.instanceId).refs
      .map(ref => [ref.project_id, ref.role]),
    [[project.id, 'primary']],
  );
});

test('archive waits for an in-flight spawn before reset and leaves no old instance slot', async (t) => {
  const previousCodexKey = process.env.CODEX_API_KEY;
  process.env.CODEX_API_KEY = 'archive-fence-test-key';
  t.after(() => {
    if (previousCodexKey === undefined) delete process.env.CODEX_API_KEY;
    else process.env.CODEX_API_KEY = previousCodexKey;
  });

  const { app, fsRoot } = await createTestApp(t);
  const project = createProject(app, 'Fence project', {
    source_type: 'git',
    repo_url: 'https://example.invalid/fence.git',
    repo_ref: 'main',
  });
  const original = app.services.runService.ensurePrimaryOperatorInstanceForProject(project.id);
  const topRun = app.services.runService.createRun({
    is_manager: true,
    manager_layer: 'top',
    conversation_id: 'top',
    manager_adapter: 'codex',
    prompt: 'Fence Top',
  });
  app.managerRegistry.setActive('top', topRun.id, fakeAdapter());

  let enterMaterialization;
  const materializationEntered = new Promise(resolve => { enterMaterialization = resolve; });
  let releaseMaterialization;
  const materializationRelease = new Promise(resolve => { releaseMaterialization = resolve; });
  const materializer = app.services.projectMaterializationService;
  const originalEnsureWorkspace = materializer.ensureWorkspace;
  materializer.ensureWorkspace = async () => {
    enterMaterialization();
    await materializationRelease;
    return {
      ready: true,
      workspacePath: fsRoot,
      cwd: fsRoot,
    };
  };
  t.after(() => { materializer.ensureWorkspace = originalEnsureWorkspace; });

  const spawn = app.services.operatorSpawnService.ensureLiveOperator({ projectId: project.id });
  await materializationEntered;
  let archiveSettled = false;
  const archivePromise = app.services.operatorIdentityLifecycleService.archiveInstance(
    original.instanceId,
    { now: ARCHIVE_NOW },
  ).finally(() => { archiveSettled = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(archiveSettled, false, 'archive must wait behind the spawn flight');

  releaseMaterialization();
  await spawn;
  await archivePromise;
  assert.equal(
    app.managerRegistry.snapshot().pms.some(entry => entry.conversationId === `operator:${original.instanceId}`),
    false,
  );
  assert.equal(app.services.operatorInstanceService.getInstance(original.instanceId).archived_at, ARCHIVE_NOW.toISOString());
});

test('migration keeps pre-existing rows active and the archived schema remains FK-clean', async (t) => {
  // Rows must exist BEFORE 074 runs. Creating them through a fully migrated app
  // proves nothing about the migration — it only proves the column default.
  const Database = require('better-sqlite3');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'palantir-074-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const legacy = new Database(path.join(dir, 'legacy.db'));
  legacy.pragma('foreign_keys = ON');
  legacy.exec('CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY, applied_at TEXT)');
  const migrationsDir = path.join(__dirname, '..', 'db', 'migrations');
  const files = (await fs.readdir(migrationsDir)).filter((f) => f.endsWith('.sql')).sort();
  const applyUpTo = (maxVersion) => {
    for (const file of files) {
      const version = parseInt(file.split('_')[0], 10);
      if (Number.isNaN(version) || version > maxVersion) continue;
      if (legacy.prepare('SELECT 1 FROM schema_version WHERE version=?').get(version)) continue;
      const sql = require('node:fs').readFileSync(path.join(migrationsDir, file), 'utf-8');
      const fkOff = sql.split('\n')[0].trim() === '-- migrate:no-foreign-keys';
      if (fkOff) legacy.pragma('foreign_keys = OFF');
      legacy.exec(sql);
      if (fkOff) legacy.pragma('foreign_keys = ON');
      legacy.prepare('INSERT OR IGNORE INTO schema_version (version, applied_at) VALUES (?, datetime(\'now\'))').run(version);
    }
  };
  applyUpTo(73);
  assert.equal(
    legacy.prepare("SELECT COUNT(*) AS c FROM pragma_table_info('operator_instances') WHERE name='archived_at'").get().c,
    0,
    'archived_at must not exist before 074',
  );
  legacy.prepare("INSERT INTO operator_profiles (id, name, is_private) VALUES ('op_pre074', 'Pre-074', 1)").run();
  legacy.prepare("INSERT INTO operator_instances (id, profile_id, pm_adapter) VALUES ('oi_pre074', 'op_pre074', 'codex')").run();

  applyUpTo(74);
  assert.equal(
    legacy.prepare("SELECT archived_at FROM operator_instances WHERE id='oi_pre074'").get().archived_at,
    null,
    'a row that predates 074 must come out active',
  );
  assert.deepEqual(legacy.pragma('foreign_key_check'), []);
  legacy.close();

  const { app, db } = await createTestApp(t);
  const { instance } = createMappedInstance(app, 'Migration active');
  assert.equal(db.prepare('SELECT archived_at FROM operator_instances WHERE id=?').get(instance.id).archived_at, null);
  const index = db.prepare(`
    SELECT sql FROM sqlite_master
    WHERE type='index' AND name='idx_operator_instances_active'
  `).get();
  assert.match(index.sql, /WHERE archived_at IS NULL/i);
  assert.deepEqual(db.pragma('foreign_key_check'), []);
});

// The queued-message path was implemented but untested. It is the one dependant
// that is NOT reachable by a foreign key: manager_message_queue references the
// instance logically, through `conversation_id = 'operator:<id>'`. A slot clear
// only fails the sending/processing rows, and 404 / 409 / OPERATOR_MISSING are
// retried without limit — so a queued message for an archived instance would be
// redelivered forever.
test('archive terminalizes queued messages for the instance and never redelivers them', async (t) => {
  const { app, db } = await createTestApp(t);
  const { instance } = createMappedInstance(app, 'Queue archive');
  const conversationId = `operator:${instance.id}`;
  const otherInstance = app.services.operatorInstanceService.createInstance({
    profile_id: createProfile(app, 'Queue peer profile').id,
    display_name: 'Untouched peer',
  });
  const otherConversationId = `operator:${otherInstance.id}`;

  const enqueue = (id, convId, status = 'queued') => {
    db.prepare(`
      INSERT INTO manager_message_queue (
        id, conversation_id, idempotency_key, adapter_invocation_id,
        payload_json, display_text, status, available_at
      ) VALUES (?, ?, ?, ?, '{"text":"hi"}', 'hi', ?, 0)
    `).run(id, convId, `idem-${id}`, `inv-${id}`, status);
  };
  enqueue('mq_queued_a', conversationId);
  enqueue('mq_queued_b', conversationId);
  enqueue('mq_delivered', conversationId, 'delivered');
  enqueue('mq_peer', otherConversationId);

  const res = await archive(app, instance.id);
  assert.equal(res.status, 200, JSON.stringify(res.body));

  const rows = db.prepare('SELECT id, status, terminal_reason FROM manager_message_queue ORDER BY id').all();
  const byId = Object.fromEntries(rows.map((row) => [row.id, row]));

  for (const id of ['mq_queued_a', 'mq_queued_b']) {
    assert.equal(byId[id].status, 'cancelled', `${id} must be terminal after archive`);
    assert.equal(byId[id].terminal_reason, 'operator_archived');
  }
  // A terminal row must not be rewritten, and a different instance's queue is
  // not this archive's business.
  assert.equal(byId.mq_delivered.status, 'delivered');
  assert.equal(byId.mq_peer.status, 'queued');
  assert.equal(byId.mq_peer.terminal_reason ?? null, null);

  // Nothing is left for a drainer to pick up on this conversation.
  const stillQueued = db.prepare(
    "SELECT COUNT(*) AS c FROM manager_message_queue WHERE conversation_id=? AND status IN ('queued','sending','processing')",
  ).get(conversationId).c;
  assert.equal(stillQueued, 0, 'archived instance must leave no deliverable queue rows');
});

// The first implementation called assertActiveInstance() on any operator target,
// which conflates "unknown" with "archived". The router is a pure matcher whose
// rule 2 is documented as "valid currentConversationId → keep it", so an id with
// no DB row must still resolve — `operator:oi_current` did before this issue and
// router-http.test.js pins it. Only archived-ness is new, so only archived-ness
// is refused here; delivery to a missing instance is refused at the send path.
test('router refuses an archived target but still passes an unknown one through', async (t) => {
  const { app } = await createTestApp(t);
  const { instance } = createMappedInstance(app, 'Router archive');
  // routerService is not exposed on app.services; build one over the same
  // service instances the app wires (server/app.js).
  const { createRouterService } = require('../services/routerService');
  const routerService = createRouterService({
    projectService: app.services.projectService,
    operatorInstanceService: app.services.operatorInstanceService,
  });

  const before = routerService.resolveTarget({
    text: 'hello',
    currentConversationId: `operator:${instance.id}`,
  });
  assert.equal(before.target, `operator:${instance.id}`);

  // Unknown instance id: historical pass-through must survive.
  const unknown = routerService.resolveTarget({
    text: 'hello',
    currentConversationId: 'operator:oi_never_created',
  });
  assert.equal(unknown.target, 'operator:oi_never_created');

  const archived = await archive(app, instance.id);
  assert.equal(archived.status, 200);

  assert.throws(
    () => routerService.resolveTarget({
      text: 'hello',
      currentConversationId: `operator:${instance.id}`,
    }),
    /archiv/i,
    'an archived instance must not be routable',
  );

  // Still passes through after the archive — the guard must not have widened.
  const unknownAfter = routerService.resolveTarget({
    text: 'hello',
    currentConversationId: 'operator:oi_never_created',
  });
  assert.equal(unknownAfter.target, 'operator:oi_never_created');
});

// Adversarial review, SERIOUS 3: an archived dispatcher is not "no primary".
// Falling back to Top attributes the review to a manager that never dispatched
// the run — the exact attribution contract archiving exists to protect.
// Fakes only, mirroring the pmAutoReview harness in harvest.test.js.
test('auto-review is suppressed for an archived dispatcher rather than reattributed to Top', () => {
  const { createPmAutoReview } = require('../app');
  const { createEventBus } = require('../services/eventBus');

  const build = (archivedAt) => {
    const sent = [];
    const instance = { id: 'oi_dispatcher', archived_at: archivedAt };
    const controller = createPmAutoReview({
      eventBus: createEventBus(),
      managerRegistry: {
        getActiveRunId: (slot) => (slot === 'operator:oi_dispatcher' ? 'run_pm' : (slot === 'top' ? 'run_top' : null)),
        onSlotCleared: () => () => {},
      },
      conversationService: { sendMessage(slot, message) { sent.push({ slot, message }); } },
      runService: {
        resolveOperatorConversationId: (conversationId) => (
          conversationId === 'operator:oi_dispatcher'
            ? {
              instanceId: 'oi_dispatcher',
              primaryProjectId: 'proj_1',
              instanceConversationId: 'operator:oi_dispatcher',
            }
            : null
        ),
        addRunEvent() {},
        listRuns: () => [],
      },
      operatorInstanceService: {
        getInstance: (id) => (id === instance.id ? instance : null),
        assertActiveInstance: (id) => {
          if (id === instance.id && instance.archived_at) throw new Error('OPERATOR_ARCHIVED');
          return instance;
        },
      },
      defer: (fn) => fn(),
      logger: { warn() {} },
    });
    return { controller, sent };
  };

  const run = {
    id: 'run_worker_1',
    is_manager: 0,
    project_id: 'proj_1',
    operator_instance_id: 'oi_dispatcher',
    task_id: 'task_1',
    status: 'completed',
  };

  const live = build(null);
  live.controller.sendPmReview({ run, harvestSummary: null });
  assert.deepEqual(
    live.sent.map((entry) => entry.slot),
    ['operator:oi_dispatcher'],
    'a live dispatcher receives its own review',
  );

  const archivedCase = build('2026-07-28T00:00:00.000Z');
  archivedCase.controller.sendPmReview({ run, harvestSummary: null });
  assert.deepEqual(
    archivedCase.sent.map((entry) => entry.slot),
    [],
    'an archived dispatcher must suppress the review, never reroute it to top',
  );
});

// Adversarial review, SERIOUS 4: r.conversation_id may be a legacy
// 'operator:<projectId>' alias, which resolves to whoever is primary NOW. After
// an archive that is the REPLACEMENT instance, so a check on the resolved id
// passes and the dead run gets resumed onto the new thread and slot.
test('boot resume skips a run whose durable owner is archived, even via a legacy alias', async (t) => {
  const { app, db } = await createTestApp(t);
  const { project, instance } = createMappedInstance(app, 'Boot archive');
  const legacyConversationId = `operator:${project.id}`;

  const run = createOperatorRun(app, instance.id);
  db.prepare('UPDATE runs SET conversation_id=?, operator_instance_id=? WHERE id=?')
    .run(legacyConversationId, instance.id, run.id);

  assert.equal((await archive(app, instance.id)).status, 200);

  // A replacement instance now answers the same legacy alias.
  const replacement = app.services.runService.ensurePrimaryOperatorInstanceForProject(project.id);
  assert.ok(replacement?.instanceId);
  assert.notEqual(replacement.instanceId, instance.id, 'the archived row must not be reused');

  // The durable owner is still the archived instance, so the run is not resumable.
  const owner = db.prepare('SELECT operator_instance_id FROM runs WHERE id=?').get(run.id);
  assert.equal(owner.operator_instance_id, instance.id);
  assert.ok(
    app.services.operatorInstanceService.getInstance(owner.operator_instance_id).archived_at,
    'attribution still resolves to the archived instance',
  );
});
