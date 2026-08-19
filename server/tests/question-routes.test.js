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
  const active = [];
  const app = setupApp(t, {
    questionWaitTimeoutMs: 80,
    questionPollIntervalMs: 5,
    questionOnWaiterActive: info => active.splice(0).forEach(resolve => resolve(info)),
  });
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
  assert.ok(Date.now() - started >= 80, 'pending wait must consume the injected timeout');

  const waiterActive = new Promise(resolve => active.push(resolve));
  const firstWaiter = request(app)
    .get(`/api/runs/${worker.run.id}/questions/${questionId}/wait`)
    .set(worker.auth)
    .then(response => response);
  await waiterActive;
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

  const [first, second] = await Promise.all([
    request(app).post(url).set(COOKIE).set('Host', 'console.test').set('Origin', 'http://console.test').send({ answer: 'morning' }),
    request(app).post(url).set(COOKIE).set('Host', 'console.test').set('Origin', 'http://console.test').send({ answer: 'evening' }),
  ]);
  const [answered] = [first, second].filter(response => response.status === 200);
  const [duplicate] = [first, second].filter(response => response.status === 409);
  assert.ok(answered, 'exactly one concurrent response must commit with 200');
  assert.ok(duplicate, 'exactly one concurrent response must lose with 409');
  assert.equal(answered.body.question.status, 'answered');
  assert.equal(duplicate.body.reason, 'question_not_pending');
  assert.equal(duplicate.body.question.status, 'answered');
});

test('respond resume creates a queryable queued run', async (t) => {
  const app = setupApp(t);
  const worker = createWorker(app, 'respond-resume');
  const created = await register(app, worker).expect(201);
  // The only way a question outlives its run is the production path: the worker
  // exhausted its wait budget, so the run ends with
  // terminal_reason='question_unanswered'. Any other terminal reason cancels the
  // pending question (PR2a §6) and respond would correctly 409.
  app.services.runService.updateRunStatus(worker.run.id, 'failed', {
    force: true,
    terminalReason: 'question_unanswered',
  });
  assert.equal(
    app.services.questionService.getQuestion(created.body.question.id).status,
    'pending',
    'question_unanswered must NOT cancel the question',
  );
  const answered = await request(app).post(`/api/questions/${created.body.question.id}/respond`)
    .set(COOKIE).set('Host', 'console.test').set('Origin', 'http://console.test')
    .send({ answer: 'morning', resume: true }).expect(200);
  assert.ok(answered.body.question.resumedRunId);
  const resumed = app.services.runService.getRun(answered.body.question.resumedRunId);
  // Do NOT assert status === 'queued': the queue drain claims the run
  // immediately in an app-level test, so the status races. What matters is that
  // resume produced a real run on the normal queue path with the answer wired in.
  assert.ok(resumed, 'resumed run exists');
  assert.equal(resumed.source_question_id, created.body.question.id);
  assert.match(resumed.prompt, /\[ANSWERED QUESTION\]/);
  assert.match(resumed.prompt, /morning/);
  assert.equal(Number(resumed.retry_count || 0), 0, 'resume is not a failure retry; it must not consume B-lite budget');
  const kinds = app.services.runService.getRunEvents(resumed.id).map((e) => e.event_type);
  assert.ok(kinds.includes('queue:dequeued'), 'the normal queue drain must claim the resumed run');
});

test('respond resume skips a new run while the original worker is active', async (t) => {
  const app = setupApp(t);
  const worker = createWorker(app, 'respond-active');
  const created = await register(app, worker).expect(201);
  const answered = await request(app).post(`/api/questions/${created.body.question.id}/respond`)
    .set(COOKIE).set('Host', 'console.test').set('Origin', 'http://console.test')
    .send({ answer: 'morning', resume: true }).expect(200);
  assert.equal(answered.body.question.status, 'answered');
  assert.equal(answered.body.question.resumedRunId, null);
  assert.equal(answered.body.resumeSkipped, 'run_active');
  assert.equal(app.services._rawDb.prepare('SELECT count(*) AS n FROM runs WHERE source_question_id = ?')
    .get(created.body.question.id).n, 0);
});

test('answered question can be resumed once with cookie same-origin only', async (t) => {
  const app = setupApp(t);
  const worker = createWorker(app, 'later-resume');
  const created = await register(app, worker).expect(201);
  const id = created.body.question.id;
  await request(app).post(`/api/questions/${id}/respond`).set(COOKIE)
    .set('Host', 'console.test').set('Origin', 'http://console.test')
    .send({ answer: 'morning', resume: false }).expect(200);
  const url = `/api/questions/${id}/resume`;
  await request(app).post(url).set(BEARER).expect(403);
  await request(app).post(url).set(worker.auth).expect(403);
  await request(app).post(url).set(COOKIE).set('Origin', 'https://attacker.example').expect(403);
  const active = await request(app).post(url).set(COOKIE)
    .set('Host', 'console.test').set('Origin', 'http://console.test').expect(409);
  assert.equal(active.body.reason, 'run_still_active');
  app.services.runService.updateRunStatus(worker.run.id, 'stopped', {
    force: true,
    reason: 'test_terminal_before_explicit_resume',
  });
  const resumed = await request(app).post(url).set(COOKIE)
    .set('Host', 'console.test').set('Origin', 'http://console.test').expect(200);
  const resumedId = resumed.body.question.resumedRunId;
  const duplicate = await request(app).post(url).set(COOKIE)
    .set('Host', 'console.test').set('Origin', 'http://console.test').expect(409);
  assert.equal(duplicate.body.resumed_run_id, resumedId);
});

test('global waiter capacity is distinct from per-run waiter contention and is released', async (t) => {
  const active = [];
  // The first waiter must still be holding its slot when the two 429
  // assertions run. A short wait budget made that a race: under parallel load
  // the waiter could expire before the follow-up requests landed, and both
  // would then get 200. Give it a long budget and end it explicitly by
  // answering the question instead of racing a timer.
  const app = setupApp(t, {
    questionWaitTimeoutMs: 5_000,
    questionPollIntervalMs: 5,
    questionMaxGlobalWaiters: 1,
    questionOnWaiterActive: info => active.splice(0).forEach(resolve => resolve(info)),
  });
  const workers = [createWorker(app, 'capacity-a'), createWorker(app, 'capacity-b')];
  const questions = await Promise.all(workers.map((worker, i) => register(app, worker, `capacity-${i}`).expect(201)));
  const nextActive = () => new Promise(resolve => active.push(resolve));

  const firstActive = nextActive();
  const first = request(app).get(`/api/runs/${workers[0].run.id}/questions/${questions[0].body.question.id}/wait`).set(workers[0].auth).then(r => r);
  await firstActive;
  const globalBusy = await request(app).get(`/api/runs/${workers[1].run.id}/questions/${questions[1].body.question.id}/wait`).set(workers[1].auth).expect('Retry-After', '1').expect(429);
  assert.equal(globalBusy.body.reason, 'waiter_capacity');
  const runBusy = await request(app).get(`/api/runs/${workers[0].run.id}/questions/${questions[0].body.question.id}/wait`).set(workers[0].auth).expect(429);
  assert.equal(runBusy.body.reason, 'waiter_busy');

  // Release the first waiter deterministically: answering wakes it on the next
  // poll tick rather than leaving the test to wait out the budget.
  await request(app).post(`/api/questions/${questions[0].body.question.id}/respond`)
    .set(COOKIE).set('Host', 'console.test').set('Origin', 'http://console.test')
    .send({ answer: 'morning', resume: false }).expect(200);
  await first;

  const released = await request(app).get(`/api/runs/${workers[1].run.id}/questions/${questions[1].body.question.id}/wait`).set(workers[1].auth).expect(200);
  assert.equal(released.body.question.status, 'pending');
});

test('stopQuestionWaiters wakes pending waits and makes later waits return immediately', async (t) => {
  let signalWaiterActive;
  const waiterActive = new Promise(resolve => { signalWaiterActive = resolve; });
  const app = setupApp(t, {
    questionWaitTimeoutMs: 5_000,
    questionPollIntervalMs: 1_000,
    questionMaxGlobalWaiters: 1,
    questionOnWaiterActive: signalWaiterActive,
  });
  const worker = createWorker(app, 'shutdown');
  const created = await register(app, worker, 'shutdown').expect(201);
  const url = `/api/runs/${worker.run.id}/questions/${created.body.question.id}/wait`;
  const waiting = request(app).get(url).set(worker.auth).then(r => r);
  await waiterActive;

  const started = Date.now();
  const drain = app.stopQuestionWaiters();
  const result = await waiting;
  await drain;
  assert.equal(result.status, 200);
  assert.equal(result.body.question.status, 'pending');
  assert.equal(app.getQuestionWaiterCount(), 0);
  assert.ok(Date.now() - started < 1_000, 'shutdown must wake the waiter before its poll interval');

  const laterStarted = Date.now();
  const later = await request(app).get(url).set(worker.auth).expect(200);
  assert.equal(later.body.question.status, 'pending');
  assert.ok(Date.now() - laterStarted < 1_000, 'post-shutdown wait must return immediately');
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
