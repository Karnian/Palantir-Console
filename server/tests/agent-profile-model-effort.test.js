const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const { createDatabase } = require('../db/database');
const { createAgentProfileService } = require('../services/agentProfileService');

function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'palantir-agent-model-effort-'));
  const database = createDatabase(path.join(dir, 'test.db'));
  database.migrate();
  t.after(() => {
    try { database.close(); } catch { /* already closed */ }
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { db: database.db, service: createAgentProfileService(database.db) };
}

function profile(overrides = {}) {
  return {
    name: 'Test worker',
    type: 'codex',
    command: 'codex',
    args_template: 'exec --full-auto --skip-git-repo-check {prompt}',
    ...overrides,
  };
}

function assertBadRequest(fn, message) {
  assert.throws(fn, (error) => {
    assert.equal(error.status, 400);
    if (message) assert.match(error.message, message);
    return true;
  });
}

test('migration adds structured columns and create/read round-trips them', (t) => {
  const { db, service } = setup(t);
  const columns = db.prepare('PRAGMA table_info(agent_profiles)').all().map(row => row.name);
  assert.ok(columns.includes('model'));
  assert.ok(columns.includes('reasoning_effort'));

  const created = service.createProfile(profile({ model: 'gpt-5', reasoning_effort: 'medium' }));
  assert.equal(created.model, 'gpt-5');
  assert.equal(created.reasoning_effort, 'medium');
  assert.equal(service.getProfile(created.id).model, 'gpt-5');
  assert.equal(service.getProfile(created.id).reasoning_effort, 'medium');
});

test('vendor rules reject unsupported fields and allow clean codex fields', (t) => {
  const { service } = setup(t);
  assertBadRequest(
    () => service.createProfile(profile({ command: 'claude', type: 'claude-code', reasoning_effort: 'high' })),
    /reasoning_effort only supported for codex workers/,
  );
  for (const command of ['gemini', 'opencode']) {
    assertBadRequest(
      () => service.createProfile(profile({ command, type: command, model: 'x' })),
      /model only supported for codex\/claude workers/,
    );
  }

  const created = service.createProfile(profile({ model: 'gpt-5', reasoning_effort: 'high' }));
  assert.equal(created.model, 'gpt-5');
  assert.equal(created.reasoning_effort, 'high');
});

test('structured values are validated at create time', (t) => {
  const { service } = setup(t);
  assertBadRequest(() => service.createProfile(profile({ reasoning_effort: 'maximum' })), /reasoning_effort must be one of/);

  for (const model of ['', 'x'.repeat(201), 'gpt\n5', '-gpt-5']) {
    assertBadRequest(() => service.createProfile(profile({ model })), /model must be a non-empty string/);
  }
});

test('create rejects structured fields duplicated in args_template', (t) => {
  const { service } = setup(t);
  assertBadRequest(
    () => service.createProfile(profile({
      reasoning_effort: 'high',
      args_template: 'exec -c \'model_reasoning_effort="high"\' {prompt}',
    })),
    /structured reasoning_effort conflicts with a flag in args_template; use one/,
  );

  for (const args_template of ['exec -m y {prompt}', 'exec --model y {prompt}', 'exec -c model=y {prompt}']) {
    assertBadRequest(
      () => service.createProfile(profile({ model: 'x', args_template })),
      /structured model conflicts with a flag in args_template; use one/,
    );
  }
});

test('unrelated options do not false-positive as model flags', (t) => {
  const { service } = setup(t);
  const codex = service.createProfile(profile({
    model: 'x',
    args_template: 'exec --full-auto --skip-git-repo-check {prompt}',
  }));
  assert.equal(codex.model, 'x');

  const claude = service.createProfile(profile({
    command: 'claude',
    type: 'claude-code',
    model: 'x',
    args_template: '-p {prompt} --permission-mode bypassPermissions --mcp-config foo --max-budget-usd 5',
  }));
  assert.equal(claude.model, 'x');
});

test('update validates the merged persisted and patched state', (t) => {
  const { service } = setup(t);
  const baked = service.createProfile(profile({
    args_template: 'exec --full-auto --skip-git-repo-check -c \'model_reasoning_effort="high"\' {prompt}',
  }));
  assert.equal(baked.reasoning_effort, null);
  assertBadRequest(
    () => service.updateProfile(baked.id, { reasoning_effort: 'high' }),
    /structured reasoning_effort conflicts with a flag in args_template; use one/,
  );

  const structured = service.createProfile(profile({ model: 'x' }));
  assertBadRequest(
    () => service.updateProfile(structured.id, { command: 'gemini' }),
    /model only supported for codex\/claude workers/,
  );
});
