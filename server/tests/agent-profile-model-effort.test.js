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
  assert.ok(columns.includes('permission_mode'));
  assert.equal(
    db.prepare('SELECT permission_mode FROM agent_profiles WHERE id = ?').get('claude-code').permission_mode,
    null,
  );

  const created = service.createProfile(profile({ model: 'gpt-5', reasoning_effort: 'medium' }));
  assert.equal(created.model, 'gpt-5');
  assert.equal(created.reasoning_effort, 'medium');
  assert.equal(created.permission_mode, null);
  assert.equal(service.getProfile(created.id).model, 'gpt-5');
  assert.equal(service.getProfile(created.id).reasoning_effort, 'medium');
});

test('vendor rules reject unsupported fields and allow clean codex fields', (t) => {
  const { service } = setup(t);
  assertBadRequest(
    () => service.createProfile(profile({ command: 'claude', type: 'claude-code', reasoning_effort: 'high' })),
    /reasoning_effort only supported for codex workers/,
  );
  for (const command of ['gemini']) {
    assertBadRequest(
      () => service.createProfile(profile({ command, type: command, model: 'x' })),
      /model only supported for codex\/claude workers/,
    );
  }

  const created = service.createProfile(profile({ model: 'gpt-5', reasoning_effort: 'high' }));
  assert.equal(created.model, 'gpt-5');
  assert.equal(created.reasoning_effort, 'high');
});

test('retired opencode commands are rejected at create time', (t) => {
  const { service } = setup(t);
  for (const command of ['opencode', '/opt/homebrew/bin/opencode', '/usr/local/bin/opencode']) {
    assertBadRequest(
      () => service.createProfile(profile({ type: 'custom', command })),
      /not in the allowlist/,
    );
  }
});

test('retired opencode type is rejected on create and merged-state update', (t) => {
  const { service } = setup(t);
  assertBadRequest(
    () => service.createProfile(profile({ type: 'opencode', command: 'gemini' })),
    /opencode is a retired agent type, no longer supported/,
  );

  const created = service.createProfile(profile({ type: 'custom', command: 'gemini' }));
  assertBadRequest(
    () => service.updateProfile(created.id, { type: 'opencode' }),
    /opencode is a retired agent type, no longer supported/,
  );
});

test('structured values are validated at create time', (t) => {
  const { service } = setup(t);
  assertBadRequest(() => service.createProfile(profile({ reasoning_effort: 'maximum' })), /reasoning_effort must be one of/);

  for (const model of ['', 'x'.repeat(201), 'gpt\n5', '-gpt-5']) {
    assertBadRequest(() => service.createProfile(profile({ model })), /model must be a non-empty string/);
  }
});

test('permission_mode accepts only Claude CLI modes and only for claude workers', (t) => {
  const { service } = setup(t);
  const validModes = [
    'acceptEdits',
    'auto',
    'bypassPermissions',
    'default',
    'dontAsk',
    'manual',
    'plan',
  ];

  for (const permission_mode of validModes) {
    const created = service.createProfile(profile({
      name: `Claude ${permission_mode}`,
      command: 'claude',
      type: 'claude-code',
      args_template: '-p {prompt}',
      permission_mode,
    }));
    assert.equal(created.permission_mode, permission_mode);
  }

  assertBadRequest(
    () => service.createProfile(profile({
      command: 'claude',
      type: 'claude-code',
      permission_mode: 'unrestricted',
    })),
    /permission_mode must be one of/,
  );
  assertBadRequest(
    () => service.createProfile(profile({ permission_mode: 'plan' })),
    /permission_mode only supported for claude workers/,
  );
});

test('claude save rejects permission mode flags in the raw args_template', (t) => {
  const { service } = setup(t);
  for (const args_template of [
    '-p {prompt} --permission-mode acceptEdits',
    '-p {prompt} --permission-mode=plan',
    '-p {prompt} "--permission-mode" bypassPermissions',
  ]) {
    assertBadRequest(
      () => service.createProfile(profile({
        command: 'claude',
        type: 'claude-code',
        args_template,
      })),
      /args_template must not set --permission-mode/,
    );
  }

  const clean = service.createProfile(profile({
    command: 'claude',
    type: 'claude-code',
    args_template: '-p {prompt}',
  }));
  assert.equal(clean.args_template, '-p {prompt}');
  assertBadRequest(
    () => service.updateProfile(clean.id, {
      args_template: '-p {prompt} --permission-mode dontAsk',
    }),
    /args_template must not set --permission-mode/,
  );
});

test('a legacy claude profile carrying the flag stays editable until the template is touched', (t) => {
  const { service, db } = setup(t);
  // Rows like this exist by construction: putting --permission-mode in
  // args_template is precisely the workaround #469 describes, and the Claude
  // spawn path has always ignored it. Raw SQL because createProfile now refuses
  // this shape — the point is a row written before that rule existed.
  const legacy = service.createProfile(profile({
    command: 'claude',
    type: 'claude-code',
    args_template: '-p {prompt}',
  }));
  db.prepare('UPDATE agent_profiles SET args_template = ? WHERE id = ?')
    .run('-p {prompt} --permission-mode acceptEdits', legacy.id);

  // AgentsView sends the whole visible form even when only the name changed.
  // This UI-shaped PATCH must not make unchanged command/template keys look
  // like an attempt to introduce the legacy raw flag.
  const renamed = service.updateProfile(legacy.id, {
    name: 'renamed legacy',
    type: 'claude-code',
    command: 'claude',
    args_template: '-p {prompt} --permission-mode acceptEdits',
    model: null,
    reasoning_effort: null,
    permission_mode: null,
    max_concurrent: 1,
    capabilities_json: '{}',
  });
  assert.equal(renamed.name, 'renamed legacy');
  assert.equal(renamed.args_template, '-p {prompt} --permission-mode acceptEdits');

  // Changing only the executable path keeps the same Claude vendor and must
  // not revalidate an untouched legacy template.
  const relocated = service.updateProfile(legacy.id, { command: '/usr/local/bin/claude' });
  assert.equal(relocated.command, '/usr/local/bin/claude');
  assert.equal(relocated.args_template, '-p {prompt} --permission-mode acceptEdits');

  // Setting the structured field is likewise allowed; it is what fixes the row.
  const structured = service.updateProfile(legacy.id, { permission_mode: 'plan' });
  assert.equal(structured.permission_mode, 'plan');

  // But touching the template itself now has to clean it up.
  assertBadRequest(
    () => service.updateProfile(legacy.id, {
      args_template: '-p {prompt} --permission-mode acceptEdits --verbose',
    }),
    /args_template must not set --permission-mode/,
  );
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
    args_template: '-p {prompt} --mcp-config foo --max-budget-usd 5',
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

  const claude = service.createProfile(profile({
    command: 'claude',
    type: 'claude-code',
    args_template: '-p {prompt}',
    permission_mode: 'acceptEdits',
  }));
  assertBadRequest(
    () => service.updateProfile(claude.id, { command: 'codex' }),
    /permission_mode only supported for claude workers/,
  );
});
