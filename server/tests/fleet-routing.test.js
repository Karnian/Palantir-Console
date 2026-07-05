const test = require('node:test');
const assert = require('node:assert/strict');

const { createLifecycleService } = require('../services/lifecycleService');

test('fleet routing treats a missing queued node as unreachable and leaves the run queued', async () => {
  const runs = [{
    id: 'run-missing-node',
    task_id: 'task-1',
    agent_profile_id: 'profile-1',
    status: 'queued',
    is_manager: 0,
    node_id: 'deleted-node',
    prompt: 'stay queued',
  }];

  const lifecycleService = createLifecycleService({
    runService: {
      listRuns(filter = {}) {
        return runs.filter((run) => !filter.status || run.status === filter.status);
      },
      countRunningOnNode() {
        throw new Error('missing nodes must short-circuit before capacity counts');
      },
      countRunningTotalOnNode() {
        throw new Error('missing nodes must short-circuit before capacity counts');
      },
      getOldestQueuedOnNode() {
        throw new Error('missing nodes must not be dequeued');
      },
      getOldestQueued() {
        throw new Error('missing nodes must not be dequeued');
      },
    },
    taskService: {},
    agentProfileService: {
      getProfile(id) {
        return { id, command: 'codex', max_concurrent: 1 };
      },
    },
    projectService: {},
    executionEngine: {},
    streamJsonEngine: {},
    nodeService: {
      getNode() {
        throw new Error('Node not found: deleted-node');
      },
    },
    nodeExecutor: {
      async spawnWorker() {
        throw new Error('missing nodes must not spawn');
      },
    },
  });

  const started = await lifecycleService.drainQueue('profile-1');

  assert.equal(started, 0);
  assert.equal(runs[0].status, 'queued');
});
