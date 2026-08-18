const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const request = require('supertest');
const { createApp } = require('../app');

const SERVER_MAX_BYTES = 256 * 1024;

async function createFixture(t, { result, error, nodeService = true } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'palantir-output-cursor-'));
  const app = createApp({
    storageRoot: path.join(root, 'storage'),
    fsRoot: path.join(root, 'fs'),
    pluginsRoot: path.join(root, 'plugins'),
    dbPath: path.join(root, 'test.db'),
    authToken: null,
    authResolverOpts: { hasKeychain: () => false },
  });
  const server = http.createServer(app);
  t.after(async () => {
    if (server.listening) {
      if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
    if (app.shutdown) app.shutdown(); else app.closeDb();
    await fs.rm(root, { recursive: true, force: true });
  });
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
    server.listen(0, '127.0.0.1');
  });

  const calls = [];
  const executor = {
    getOutput: async () => 'legacy output',
    readOutputRange: async (...args) => {
      calls.push(args);
      if (error) throw error;
      return result || rangeResult();
    },
  };
  app.services.nodeService.createNode({
    id: 'remote-1',
    name: 'Contract fake remote',
    kind: 'ssh',
    ssh_host: 'contract.invalid',
    ssh_user: 'tester',
    exposed_roots: ['/tmp'],
  });
  if (nodeService) app.services.nodeService.pickExecutor = () => executor;

  const { projectService, taskService, agentProfileService, runService } = app.services;
  const project = projectService.createProject({ name: `cursor-${Date.now()}-${Math.random()}` });
  const task = taskService.createTask({ title: 'cursor task', project_id: project.id });
  const profile = agentProfileService.createProfile({
    name: `cursor-profile-${Date.now()}-${Math.random()}`,
    type: 'claude-code', command: 'claude', args_template: '',
  });

  function createRun({ remote = true, manager = false, status = 'queued', detached = false } = {}) {
    const run = runService.createRun(manager ? {
      is_manager: true,
      node_id: remote ? 'remote-1' : 'local',
    } : {
      task_id: task.id,
      agent_profile_id: profile.id,
      node_id: remote ? 'remote-1' : 'local',
    });
    if (status !== 'queued') runService.updateRunStatus(run.id, status, { force: true });
    if (detached) runService.addRunEvent(run.id, 'runtime:remote_worker_engine', '{}');
    return runService.getRun(run.id);
  }
  return { app: server, calls, createRun, runService };
}

function rangeResult(overrides = {}) {
  return {
    source_id: '11:22',
    data: Buffer.from('delta'),
    next_offset: 5,
    end_offset: 9,
    has_more: true,
    sealed: false,
    generation_changed: false,
    deleted: false,
    missing: false,
    ...overrides,
  };
}

test('legacy response is byte-compatible in shape and never reads a range', async (t) => {
  const f = await createFixture(t);
  const run = f.createRun();
  const res = await request(f.app).get(`/api/runs/${run.id}/output`);
  assert.equal(res.status, 200);
  assert.deepEqual(Object.keys(res.body), ['output']);
  assert.deepEqual(f.calls, []);
});

test('normal incremental response preserves offsets and base64-encodes Buffer bytes', async (t) => {
  const data = Buffer.from([0, 255, 10, 123, 34]);
  const f = await createFixture(t, { result: rangeResult({ data, next_offset: 17, end_offset: 31, has_more: true }) });
  const run = f.createRun();
  const res = await request(f.app).get(`/api/runs/${run.id}/output?after=4`);
  assert.equal(res.status, 200);
  assert.equal(res.body.data_base64, data.toString('base64'));
  assert.equal(res.body.next_offset, 17);
  assert.equal(res.body.end_offset, 31);
  assert.equal(res.body.has_more, true);
});

test('finalized is true only for sealed output with no remaining bytes', async (t) => {
  const sealedDone = await createFixture(t, { result: rangeResult({ sealed: true, has_more: false }) });
  const doneRun = sealedDone.createRun({ status: 'completed' });
  assert.equal((await request(sealedDone.app).get(`/api/runs/${doneRun.id}/output?after=0`)).body.finalized, true);

  const sealedMore = await createFixture(t, { result: rangeResult({ sealed: true, has_more: true }) });
  const moreRun = sealedMore.createRun({ status: 'completed' });
  assert.equal((await request(sealedMore.app).get(`/api/runs/${moreRun.id}/output?after=0`)).body.finalized, false);
});

test('sealed output defers finalization while the latest DB status is non-terminal', async (t) => {
  const f = await createFixture(t, { result: rangeResult({ sealed: true, has_more: false }) });
  const run = f.createRun({ status: 'running' });
  const res = await request(f.app).get(`/api/runs/${run.id}/output?after=0`);
  assert.equal(res.status, 200);
  assert.equal(res.body.finalized, false);
  assert.equal(res.body.run_status, 'running');
});

test('sealed output exposes finalization when the latest DB status is terminal', async (t) => {
  const f = await createFixture(t, { result: rangeResult({ sealed: true, has_more: false }) });
  const run = f.createRun({ status: 'completed' });
  const res = await request(f.app).get(`/api/runs/${run.id}/output?after=0`);
  assert.equal(res.status, 200);
  assert.equal(res.body.finalized, true);
  assert.equal(res.body.run_status, 'completed');
});

test('incremental output re-reads status after reading the output range', async (t) => {
  const f = await createFixture(t, { result: rangeResult({ sealed: true, has_more: false }) });
  const run = f.createRun({ status: 'running' });
  const originalGetRun = f.runService.getRun;
  let reads = 0;
  f.runService.getRun = (id) => {
    const current = originalGetRun(id);
    reads += 1;
    return reads === 1 ? current : { ...current, status: 'completed' };
  };
  const res = await request(f.app).get(`/api/runs/${run.id}/output?after=0`);
  assert.equal(res.status, 200);
  assert.equal(res.body.run_status, 'completed');
  assert.equal(res.body.finalized, true);
  assert.equal(reads, 2);
});

test('incremental response includes the run status from the same request', async (t) => {
  const f = await createFixture(t);
  const run = f.createRun({ status: 'completed' });
  const res = await request(f.app).get(`/api/runs/${run.id}/output?after=0`);
  assert.equal(res.body.run_status, 'completed');
});

test('format distinguishes detached Claude while both formats preserve raw bytes', async (t) => {
  const bytes = Buffer.from('{"type":"result","result":"raw\\nbytes"}\n', 'utf8');
  const detached = await createFixture(t, { result: rangeResult({ data: bytes }) });
  const detachedRun = detached.createRun({ detached: true });
  const detachedRes = await request(detached.app).get(`/api/runs/${detachedRun.id}/output?after=0`);
  assert.equal(detachedRes.body.format, 'claude_ndjson');
  assert.deepEqual(Buffer.from(detachedRes.body.data_base64, 'base64'), bytes);

  const plain = await createFixture(t, { result: rangeResult({ data: bytes }) });
  const plainRun = plain.createRun();
  const plainRes = await request(plain.app).get(`/api/runs/${plainRun.id}/output?after=0`);
  assert.equal(plainRes.body.format, 'text');
  assert.deepEqual(Buffer.from(plainRes.body.data_base64, 'base64'), bytes);
});

test('generation change returns a truncated reset delta', async (t) => {
  const f = await createFixture(t, { result: rangeResult({ generation_changed: true, data: Buffer.alloc(0), next_offset: 99 }) });
  const run = f.createRun();
  const res = await request(f.app).get(`/api/runs/${run.id}/output?after=7`);
  assert.equal(res.status, 200);
  assert.equal(res.body.truncated, true);
  assert.equal(res.body.data_base64, '');
  assert.equal(res.body.next_offset, 0);
});

test('missing output returns an empty non-final delta at the requested cursor', async (t) => {
  const f = await createFixture(t, { result: rangeResult({ missing: true, source_id: null, data: Buffer.alloc(0) }) });
  const run = f.createRun({ status: 'running' });
  const res = await request(f.app).get(`/api/runs/${run.id}/output?after=23`);
  assert.equal(res.status, 200);
  assert.equal(res.body.data_base64, '');
  assert.equal(res.body.source_id, null);
  assert.equal(res.body.next_offset, 23);
  assert.equal(res.body.finalized, false);
});

test('deleted terminal output is 410 output_expired', async (t) => {
  const f = await createFixture(t, { result: rangeResult({ deleted: true, data: Buffer.alloc(0) }) });
  const run = f.createRun({ status: 'failed' });
  const res = await request(f.app).get(`/api/runs/${run.id}/output?after=0`);
  assert.equal(res.status, 410);
  assert.equal(res.body.reason, 'output_expired');
  assert.equal(typeof res.body.error, 'string');
});

test('missing terminal output is 410 output_expired', async (t) => {
  const f = await createFixture(t, { result: rangeResult({ missing: true, data: Buffer.alloc(0) }) });
  const run = f.createRun({ status: 'completed' });
  const res = await request(f.app).get(`/api/runs/${run.id}/output?after=0`);
  assert.equal(res.status, 410);
  assert.equal(res.body.reason, 'output_expired');
  assert.equal(typeof res.body.error, 'string');
});

test('deleted running output is an empty delta rather than 410', async (t) => {
  const f = await createFixture(t, { result: rangeResult({ deleted: true, source_id: 'old', data: Buffer.alloc(0) }) });
  const run = f.createRun({ status: 'running' });
  const res = await request(f.app).get(`/api/runs/${run.id}/output?after=13`);
  assert.equal(res.status, 200);
  assert.equal(res.body.data_base64, '');
  assert.equal(res.body.source_id, null);
  assert.equal(res.body.next_offset, 13);
  assert.equal(res.body.finalized, false);
});

test('local run with after reports incremental_unsupported', async (t) => {
  const f = await createFixture(t);
  const run = f.createRun({ remote: false });
  const res = await request(f.app).get(`/api/runs/${run.id}/output?after=0`);
  assert.equal(res.status, 409);
  assert.equal(res.body.reason, 'incremental_unsupported');
});

test('manager run with after reports incremental_unsupported', async (t) => {
  const f = await createFixture(t);
  const run = f.createRun({ manager: true });
  const res = await request(f.app).get(`/api/runs/${run.id}/output?after=0`);
  assert.equal(res.status, 409);
  assert.equal(res.body.reason, 'incremental_unsupported');
});

test('invalid after values are rejected with 400', async (t) => {
  const f = await createFixture(t);
  const run = f.createRun();
  for (const after of ['-1', '1.5', 'NaN', '9007199254740992', ' 1 ', '1e3', '']) {
    const res = await request(f.app).get(`/api/runs/${run.id}/output?after=${encodeURIComponent(after)}`);
    assert.equal(res.status, 400, after);
  }
});

test('invalid output frame maps to the stable 500 reason', async (t) => {
  const err = new Error('bad frame');
  err.code = 'OUTPUT_FRAME_INVALID';
  const f = await createFixture(t, { error: err });
  const run = f.createRun();
  const res = await request(f.app).get(`/api/runs/${run.id}/output?after=0`);
  assert.equal(res.status, 500);
  assert.equal(res.body.reason, 'output_frame_invalid');
  assert.equal(typeof res.body.error, 'string');
});

test('client maxBytes is ignored in favor of the fixed server limit', async (t) => {
  const f = await createFixture(t);
  const run = f.createRun();
  const res = await request(f.app).get(`/api/runs/${run.id}/output?after=6&maxBytes=999999999`);
  assert.equal(res.status, 200);
  assert.deepEqual(f.calls, [[run.id, { after: 6, maxBytes: SERVER_MAX_BYTES }]]);
});
