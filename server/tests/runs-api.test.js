const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const { createDatabase } = require('../db/database');
const { createEventBus } = require('../services/eventBus');
const { createRunService } = require('../services/runService');
const { createRunsRouter } = require('../routes/runs');

test('DELETE /api/runs/:id kills a held paused owner before abandoning and deleting', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'palantir-runs-api-'));
  const database = createDatabase(path.join(dir, 'test.db'));
  database.migrate();
  t.after(async () => {
    try { database.close(); } catch { /* ignore */ }
    await fs.rm(dir, { recursive: true, force: true });
  });

  const eventBus = createEventBus();
  const runService = createRunService(database.db, eventBus);
  database.db.prepare(`
    INSERT INTO runs (id, status, is_manager, prompt)
    VALUES ('held-paused', 'paused', 0, 'delete me')
  `).run();
  database.db.prepare(`
    INSERT INTO run_owner_leases (
      run_id, lease_id, state, engine, acquired_at
    ) VALUES ('held-paused', 'lease-held-paused', 'held', 'tmux', datetime('now'))
  `).run();

  const order = [];
  eventBus.subscribe((event) => {
    if (event.channel === 'run:event' && event.data.eventType === 'worker:owner_abandoned') {
      order.push('abandon');
    }
  });
  const lifecycleService = {
    async killRunOwner(runId) {
      assert.equal(runId, 'held-paused');
      assert.equal(runService.getHeldLease(runId).state, 'held');
      order.push('kill');
    },
    async cancelRun() {
      assert.fail('held paused deletion must use the unconditional owner kill');
    },
  };
  const router = createRunsRouter({ runService, lifecycleService });
  const route = router.stack.find((layer) => (
    layer.route?.path === '/:id' && layer.route.methods.delete
  ));
  assert.ok(route, 'DELETE /:id route is registered');
  let responseBody = null;
  await new Promise((resolve, reject) => {
    route.route.stack[0].handle(
      { params: { id: 'held-paused' } },
      { json(body) { responseBody = body; resolve(); } },
      reject,
    );
  });

  assert.deepEqual(responseBody, { status: 'ok' });
  assert.deepEqual(order, ['kill', 'abandon']);
  assert.equal(database.db.prepare(
    "SELECT COUNT(*) AS count FROM runs WHERE id = 'held-paused'",
  ).get().count, 0);
  const lease = database.db.prepare(
    "SELECT * FROM run_owner_leases WHERE run_id = 'held-paused'",
  ).get();
  assert.equal(lease.state, 'abandoned');
  assert.equal(lease.evidence, 'run_deleted');
});
