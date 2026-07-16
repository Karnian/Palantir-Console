const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { PassThrough } = require('node:stream');

function createFakeChild() {
  return {
    stdin: { write() {}, end() {} },
    stderr: new PassThrough(),
    stdout: new PassThrough(),
    on() { return this; },
    kill() {},
  };
}

function createFakeRunService() {
  return {
    addRunEvent() {},
    updateManagerThreadId() {},
    updateRunResult() {},
    updateRunStatus() {},
  };
}

test('codexAdapter emits reasoning effort only when configured', async () => {
  const { createCodexAdapter } = require('../services/managerAdapters/codexAdapter');
  const captured = [];
  const adapter = createCodexAdapter({
    runService: createFakeRunService(),
    spawnFn: (_bin, args) => {
      captured.push(args);
      return createFakeChild();
    },
  });

  adapter.startSession('with_effort', {
    systemPrompt: 'sys',
    cwd: process.cwd(),
    reasoning_effort: 'high',
  });
  const withEffort = await adapter.runTurn('with_effort', { text: 'hi' });
  assert.equal(withEffort.accepted, true);
  assert.ok(captured[0].includes('model_reasoning_effort="high"'));

  adapter.startSession('without_effort', {
    systemPrompt: 'sys',
    cwd: process.cwd(),
  });
  const withoutEffort = await adapter.runTurn('without_effort', { text: 'hi' });
  assert.equal(withoutEffort.accepted, true);
  assert.equal(captured[1].some(arg => arg.includes('model_reasoning_effort')), false);

  await adapter.disposeSession('with_effort');
  await adapter.disposeSession('without_effort');
});

test('runService session snapshot round-trips model and effort', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'palantir-model-policy-wiring-'));
  const dbPath = path.join(dir, 'test.db');
  const { createDatabase } = require('../db/database');
  const { createRunService } = require('../services/runService');
  const { db, migrate, close } = createDatabase(dbPath);
  migrate();
  t.after(() => {
    close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const runService = createRunService(db, null);
  const run = runService.createRun({ is_manager: true, prompt: 'snapshot test' });
  runService.setSessionSnapshot(run.id, { sessionModel: 'm', sessionEffort: 'high' });

  const persisted = runService.getRun(run.id);
  assert.equal(persisted.session_model, 'm');
  assert.equal(persisted.session_effort, 'high');
});
