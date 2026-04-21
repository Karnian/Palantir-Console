// M3: MCP template drift detection — RunInspector surfaces templates whose
// `updated_at` moved past a run's `snapshot.applied_at`. Unit tests exercise
// `computeMcpTemplateDrift` directly + an integration path through
// createMcpTemplateService to confirm the service emits real timestamps.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const { createDatabase } = require('../db/database');
const { computeMcpTemplateDrift } = require('../routes/runs');
const { createMcpTemplateService } = require('../services/mcpTemplateService');
const { createSkillPackService } = require('../services/skillPackService');

function mkTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function setupDb(t) {
  const dbDir = mkTempDir('palantir-mcp-drift-');
  const dbPath = path.join(dbDir, 'test.db');
  const { db, migrate, close } = createDatabase(dbPath);
  migrate();
  t.after(() => {
    try { close(); } catch { /* */ }
    fs.rmSync(dbDir, { recursive: true, force: true });
  });
  return db;
}

// ─── Unit tests on the pure function ───

test('computeMcpTemplateDrift: null when snapshotCore has no mcp_server_ids', () => {
  const svc = { getTemplate: () => { throw new Error('should not be called'); } };
  assert.equal(computeMcpTemplateDrift({ name: 'x' }, '2026-04-22 00:00:00', svc), null);
  assert.equal(computeMcpTemplateDrift({ mcp_server_ids: [] }, '2026-04-22 00:00:00', svc), null);
});

test('computeMcpTemplateDrift: null when mcpTemplateService absent', () => {
  const core = { mcp_server_ids: ['tpl_x'] };
  assert.equal(computeMcpTemplateDrift(core, '2026-04-22 00:00:00', null), null);
});

test('computeMcpTemplateDrift: templates unchanged since applied_at → no drift', () => {
  const svc = {
    getTemplate: (id) => ({ id, alias: 'a_' + id, updated_at: '2026-04-22 00:00:00' }),
  };
  // updated_at == applied_at → not drifted (strict greater-than)
  const res = computeMcpTemplateDrift(
    { mcp_server_ids: ['tpl_1', 'tpl_2'] },
    '2026-04-22 00:00:00',
    svc,
  );
  assert.equal(res.modified_count, 0);
  assert.deepEqual(res.templates, []);
});

test('computeMcpTemplateDrift: flags only templates updated after applied_at', () => {
  const svc = {
    getTemplate: (id) => {
      if (id === 'tpl_old') return { id, alias: 'old_one', updated_at: '2026-04-21 00:00:00' };
      if (id === 'tpl_new') return { id, alias: 'new_one', updated_at: '2026-04-22 05:00:00' };
      throw new Error('unknown');
    },
  };
  const res = computeMcpTemplateDrift(
    { mcp_server_ids: ['tpl_old', 'tpl_new'] },
    '2026-04-22 00:00:00',
    svc,
  );
  assert.equal(res.modified_count, 1);
  assert.equal(res.templates[0].id, 'tpl_new');
  assert.equal(res.templates[0].alias, 'new_one');
});

test('computeMcpTemplateDrift: skips deleted templates (service throws)', () => {
  const svc = {
    getTemplate: (id) => {
      if (id === 'tpl_gone') throw new Error('not found');
      return { id, alias: 'here', updated_at: '2026-04-22 05:00:00' };
    },
  };
  const res = computeMcpTemplateDrift(
    { mcp_server_ids: ['tpl_gone', 'tpl_here'] },
    '2026-04-22 00:00:00',
    svc,
  );
  assert.equal(res.modified_count, 1);
  assert.equal(res.templates[0].id, 'tpl_here');
});

test('computeMcpTemplateDrift: skips templates missing updated_at (legacy seed)', () => {
  const svc = {
    getTemplate: (id) => ({ id, alias: 'legacy', updated_at: null }),
  };
  const res = computeMcpTemplateDrift(
    { mcp_server_ids: ['tpl_legacy'] },
    '2026-04-22 00:00:00',
    svc,
  );
  assert.equal(res.modified_count, 0);
});

// ─── Integration: service actually bumps updated_at on PATCH ───

test('integration: PATCH bumps updated_at past an earlier applied_at → drift', async (t) => {
  const db = setupDb(t);
  createSkillPackService(db);
  const svc = createMcpTemplateService(db);

  const tpl = svc.createTemplate({ alias: 'int_drift', command: 'echo' });
  const appliedAt = tpl.updated_at; // freeze "snapshot" moment
  // Datetime('now') resolution is 1s; wait long enough to observe the bump
  await new Promise((r) => setTimeout(r, 1100));

  const patched = svc.updateTemplate(tpl.id, { command: 'bash' });
  assert.ok(patched.updated_at > appliedAt, 'PATCH should bump updated_at past applied_at');

  const res = computeMcpTemplateDrift(
    { mcp_server_ids: [tpl.id] },
    appliedAt,
    svc,
  );
  assert.equal(res.modified_count, 1);
  assert.equal(res.templates[0].alias, 'int_drift');
});
