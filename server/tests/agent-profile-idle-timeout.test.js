const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createDatabase } = require('../db/database');
const { createAgentProfileService } = require('../services/agentProfileService');

function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'palantir-agent-idle-timeout-'));
  const database = createDatabase(path.join(dir, 'test.db'));
  database.migrate();
  t.after(() => {
    try { database.close(); } catch { /* already closed */ }
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return {
    db: database.db,
    service: createAgentProfileService(database.db),
  };
}

function profile(overrides = {}) {
  return {
    name: 'Idle timeout worker',
    type: 'codex',
    command: 'codex',
    args_template: 'exec --full-auto --skip-git-repo-check {prompt}',
    ...overrides,
  };
}

test('migration adds nullable idle_timeout_ms and service round-trips opt-in values', (t) => {
  const { db, service } = setup(t);
  const columns = db.prepare('PRAGMA table_info(agent_profiles)').all();
  assert.ok(columns.some(column => column.name === 'idle_timeout_ms'));

  const optedOut = service.createProfile(profile());
  assert.equal(optedOut.idle_timeout_ms, null);

  const configured = service.createProfile(profile({
    name: 'Configured timeout worker',
    idle_timeout_ms: 90 * 1000,
  }));
  assert.equal(configured.idle_timeout_ms, 90 * 1000);

  const cleared = service.updateProfile(configured.id, { idle_timeout_ms: null });
  assert.equal(cleared.idle_timeout_ms, null);
});

test('idle_timeout_ms rejects non-positive, fractional, and non-numeric values', (t) => {
  const { service } = setup(t);
  for (const idle_timeout_ms of [0, -1, 1.5, '60000']) {
    assert.throws(
      () => service.createProfile(profile({ idle_timeout_ms })),
      /idle_timeout_ms must be a positive integer or null/,
    );
  }
});
