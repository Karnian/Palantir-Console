'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const request = require('supertest');
const { createApp } = require('../app');

const TOKEN = 'question-route-secret';
const BEARER = { Authorization: `Bearer ${TOKEN}` };
const COOKIE = { Cookie: `palantir_token=${TOKEN}` };

function setupApp(t, options = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pal-question-routes-'));
  const app = createApp({
    storageRoot: tmp,
    fsRoot: tmp,
    dbPath: path.join(tmp, 'test.db'),
    authToken: TOKEN,
    agentProcessIsolation: true,
    memoryDistillEnabled: false,
    operatorSchedulerEnabled: false,
    questionWaitTimeoutMs: 60,
    questionPollIntervalMs: 5,
    authResolverOpts: { hasKeychain: () => false },
    ...options,
  });
  app.services._rawDb.prepare("INSERT INTO projects (id, name) VALUES ('p1', 'One')").run();
  t.after(async () => {
    try { await app.shutdown(); } catch { /* noop */ }
    fs.rmSync(tmp, { recursive: true, force: true });
  });
  return app;
}

function createWorker(app, suffix) {
  const agent = app.services.agentProfileService.createProfile({
    name: `question-worker-${suffix}`,
    type: 'codex',
    command: 'codex',
  });
  const task = app.services.taskService.createTask({
    project_id: 'p1',
    title: `Question task ${suffix}`,
  });
  const run = app.services.runService.createRun({
    task_id: task.id,
    agent_profile_id: agent.id,
    prompt: 'ask when blocked',
    is_manager: false,
  });
  assert.ok(app.services.runService.claimQueuedRun(run.id));
  const token = app.services.workerProposalTokenService.mint(run.id, { projectId: 'p1' });
  return { run, task, auth: { Authorization: `Bearer ${token}` } };
}

function questionPayload(key = 'idem-1') {
  return {
    idempotency_key: key,
    class: 'choice',
    question: 'Which deployment window should I use?',
    options: ['morning', 'evening'],
    wait_budget_ms: 60_000,
  };
}

function register(app, worker, key = 'idem-1') {
  // Not async: supertest's chainable must be returned directly so callers can
  // keep using .expect(); wrapping it in a promise loses the chain.
  return request(app)
    .post(`/api/runs/${worker.run.id}/questions`)
    .set(worker.auth)
    .send(questionPayload(key));
}

test('worker registration is run-bound, idempotent, worker-only, and active-run-only', async (t) => {
  const app = setupApp(t);
  const firstWorker = createWorker(app, 'registration-a');
  const otherWorker = createWorker(app, 'registration-b');

  const created = await register(app, firstWorker).expect(201);
  const retried = await register(app, firstWorker).expect(201);
  assert.equal(retried.body.question.id, created.body.question.id);

  await request(app)
    .post(`/api/runs/${otherWorker.run.id}/questions`)
    .set(firstWorker.auth)
    .send(questionPayload('wrong-run'))
    .expect(403);

  await request(app)
    .post(`/api/runs/${otherWorker.run.id}/questions`)
    .set(COOKIE)
    .send(questionPayload('cookie-register'))
    .expect(403);

  app.services.runService.updateRunStatus(otherWorker.run.id, 'completed', {
    force: true,
    reason: 'test_terminal',
  });
  const terminal = await register(app, otherWorker, 'terminal').expect(409);
  assert.equal(terminal.body.reason, 'run_not_active');
});

test('wait times out unchanged, enforces one waiter per run, and hides cross-run ids', async (t) => {
  const app = setupApp(t, { questionWaitTimeoutMs: 80, questionPollIntervalMs: 5 });
  const worker = createWorker(app, 'wait-a');
  const otherWorker = createWorker(app, 'wait-b');
  const created = await register(app, worker).expect(201);
  const questionId = created.body.question.id;

  const started = Date.now();
  const timedOut = await request(app)
    .get(`/api/runs/${worker.run.id}/questions/${questionId}/wait`)
    .set(worker.auth)
    .expect('Cache-Control', 'no-store')
    .expect('X-Accel-Buffering', 'no')
    .expect(200);
  assert.equal(timedOut.body.question.status, 'pending');
  assert.ok(Date.now() - started < 25_000);

  const firstWaiter = request(app)
    .get(`/api/runs/${worker.run.id}/questions/${questionId}/wait`)
    .set(worker.auth)
    .then(response => response);
  await new Promise(resolve => setTimeout(resolve, 15));
  const secondWaiter = await request(app)
    .get(`/api/runs/${worker.run.id}/questions/${questionId}/wait`)
    .set(worker.auth)
    .expect('Retry-After', '1')
    .expect(429);
  assert.equal(secondWaiter.body.reason, 'waiter_busy');
  const firstResult = await firstWaiter;
  assert.equal(firstResult.status, 200);
  assert.equal(firstResult.body.question.status, 'pending');

  await request(app)
    .get(`/api/runs/${otherWorker.run.id}/questions/${questionId}/wait`)
    .set(otherWorker.auth)
    .expect(404);
});

test('respond is cookie-only, same-origin, and first-commit-wins with current state', async (t) => {
  const app = setupApp(t);
  const worker = createWorker(app, 'respond');
  const created = await register(app, worker).expect(201);
  const url = `/api/questions/${created.body.question.id}/respond`;

  await request(app).post(url).set(BEARER).send({ answer: 'morning' }).expect(403);
  await request(app).post(url).set(worker.auth).send({ answer: 'morning' }).expect(403);
  await request(app)
    .post(url)
    .set(COOKIE)
    .set('Origin', 'https://attacker.example')
    .send({ answer: 'morning' })
    .expect(403);

  const answered = await request(app)
    .post(url)
    .set(COOKIE)
    .send({ answer: 'morning' })
    .expect(200);
  assert.equal(answered.body.question.status, 'answered');

  const duplicate = await request(app)
    .post(url)
    .set(COOKIE)
    .send({ answer: 'morning' })
    .expect(409);
  assert.equal(duplicate.body.reason, 'question_not_pending');
  assert.equal(duplicate.body.question.status, 'answered');
});

test('human inbox filters status and worker allowlist has exact method/path boundaries', async (t) => {
  const app = setupApp(t);
  const worker = createWorker(app, 'boundaries');
  const created = await register(app, worker).expect(201);
  const questionId = created.body.question.id;

  for (const auth of [COOKIE, BEARER]) {
    const inbox = await request(app)
      .get('/api/questions?status=pending')
      .set(auth)
      .expect(200);
    assert.equal(inbox.body.questions.length, 1);
    assert.equal(inbox.body.questions[0].id, questionId);
  }
  await request(app).get('/api/questions?status=pending').set(worker.auth).expect(403);
  await request(app)
    .post(`/api/runs/${worker.run.id}/questions/${questionId}/wait`)
    .set(worker.auth)
    .expect(403);
  await request(app)
    .get(`/api/runs/${worker.run.id}/questions`)
    .set(worker.auth)
    .expect(403);

  await request(app)
    .post(`/api/runs/${worker.run.id}/memory/propose`)
    .set(worker.auth)
    .send({ kind: 'pitfall', content: 'The worker memory endpoint remains available.' })
    .expect(202);
});
