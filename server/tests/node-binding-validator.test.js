'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createNodeBindingValidator } = require('../services/nodeBindingValidator');

function createFakeExecutor({
  realpathImpl = async (p) => p,
  fileExistsImpl = async () => true,
} = {}) {
  const calls = { realpath: [], fileExists: [] };
  return {
    calls,
    async realpath(p) {
      calls.realpath.push(p);
      return realpathImpl(p);
    },
    async fileExists(p) {
      calls.fileExists.push(p);
      return fileExistsImpl(p);
    },
  };
}

function createFakeNodeService(executor) {
  const calls = [];
  return {
    calls,
    pickExecutor(nodeId) {
      calls.push(nodeId);
      return executor;
    },
  };
}

function createFakeFs(existingPaths = []) {
  const existing = new Set(existingPaths);
  const calls = [];
  return {
    calls,
    existsSync(p) {
      calls.push(p);
      return existing.has(p);
    },
  };
}

test('validateBinding skips directory validation for local bindings', async () => {
  const executor = createFakeExecutor();
  const nodeService = {
    pickExecutor() {
      throw new Error('pickExecutor should not be called for local binding');
    },
  };
  const validator = createNodeBindingValidator({ nodeService, fs: createFakeFs() });

  await validator.validateBinding({ nodeId: 'local', directory: '/repo' });
  await validator.validateBinding({ directory: '/repo' });
  assert.deepEqual(executor.calls.realpath, []);
});

test('validateBinding accepts remote directory when realpath and fileExists pass', async () => {
  const executor = createFakeExecutor({ realpathImpl: async () => '/srv/repo-real' });
  const nodeService = createFakeNodeService(executor);
  const validator = createNodeBindingValidator({ nodeService, fs: createFakeFs() });

  await validator.validateBinding({ nodeId: 'node-a', directory: '/srv/repo' });

  assert.deepEqual(nodeService.calls, ['node-a']);
  assert.deepEqual(executor.calls.realpath, ['/srv/repo']);
  assert.deepEqual(executor.calls.fileExists, ['/srv/repo-real']);
});

test('validateBinding rejects remote directory when realpath fails', async () => {
  const executor = createFakeExecutor({
    realpathImpl: async () => {
      throw new Error('outside exposed roots');
    },
  });
  const validator = createNodeBindingValidator({
    nodeService: createFakeNodeService(executor),
    fs: createFakeFs(),
  });

  await assert.rejects(
    validator.validateBinding({ nodeId: 'node-a', directory: '/secret/repo' }),
    (err) => {
      assert.equal(err.status, 400);
      assert.match(err.message, /Directory not found or outside exposed_roots on node node-a: \/secret\/repo/);
      return true;
    },
  );
});

test('validateBinding rejects remote directory when fileExists is false', async () => {
  const executor = createFakeExecutor({
    realpathImpl: async () => '/srv/repo-real',
    fileExistsImpl: async () => false,
  });
  const validator = createNodeBindingValidator({
    nodeService: createFakeNodeService(executor),
    fs: createFakeFs(),
  });

  await assert.rejects(
    validator.validateBinding({ nodeId: 'node-a', directory: '/srv/repo' }),
    (err) => {
      assert.equal(err.status, 400);
      assert.match(err.message, /Directory not found or outside exposed_roots on node node-a: \/srv\/repo/);
      return true;
    },
  );
});

// task_85d43f96 — the bind failure used to be one undifferentiated 400, so the
// project form could only say "that directory did not work". The `reason` uses
// the same vocabulary as the /api/fs picker, and errorHandler forwards it for
// 4xx, which is what lets ProjectsView name the actual cause on save.

test('validateBinding classifies the bind failure with a picker-compatible reason', async () => {
  const cases = [
    { error: Object.assign(new Error('ssh: connect to host pod.example port 22: Connection refused'), { code: 'SSH_TRANSPORT' }), reason: 'node_unreachable' },
    { error: Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' }), reason: 'node_timeout' },
    { error: Object.assign(new Error('refused'), { code: 'EXPOSED_ROOTS' }), reason: 'path_outside_root' },
    {
      error: Object.assign(new Error('link escaped'), {
        code: 'EXPOSED_ROOTS',
        reason: 'symlink_escape',
      }),
      reason: 'symlink_escape',
    },
    { error: new Error('path /etc/shadow is outside exposed_roots for node pod-a'), reason: 'path_outside_root' },
    { error: Object.assign(new Error('command failed'), { stderr: 'realpath: /srv/locked: Permission denied\n' }), reason: 'permission_denied' },
    { error: new Error('realpath: /srv/nope: No such file or directory'), reason: 'path_not_found' },
  ];

  for (const { error, reason } of cases) {
    const executor = createFakeExecutor({ realpathImpl: async () => { throw error; } });
    const validator = createNodeBindingValidator({
      nodeService: createFakeNodeService(executor),
      fs: createFakeFs(),
    });

    await assert.rejects(
      validator.validateBinding({ nodeId: 'node-a', directory: '/srv/repo' }),
      (err) => {
        assert.equal(err.status, 400, `expected 400 for ${reason}`);
        assert.equal(err.reason, reason);
        // The historical message prefix is part of the contract — callers
        // branch on `reason`, but log scrapers still match the text.
        assert.match(err.message, /Directory not found or outside exposed_roots on node node-a: \/srv\/repo/);
        return true;
      },
    );
  }
});

test('validateBinding reports a resolvable-but-absent directory as path_not_found', async () => {
  const executor = createFakeExecutor({
    realpathImpl: async () => '/srv/repo-real',
    fileExistsImpl: async () => false,
  });
  const validator = createNodeBindingValidator({
    nodeService: createFakeNodeService(executor),
    fs: createFakeFs(),
  });

  await assert.rejects(
    validator.validateBinding({ nodeId: 'node-a', directory: '/srv/repo' }),
    (err) => {
      assert.equal(err.reason, 'path_not_found');
      return true;
    },
  );
});

test('validateBinding does NOT hard-block a missing mcp_config_path', async () => {
  // mcp_config_path is control-plane + read lazily at spawn; blocking bind on a
  // not-yet-existing file breaks the configure-first flow and the P4-2 store
  // contract (supervisor decision after P4-2 regression). No throw expected.
  const validator = createNodeBindingValidator({
    nodeService: createFakeNodeService(createFakeExecutor()),
    fs: createFakeFs([]),
  });

  await validator.validateBinding({ mcpConfigPath: '/etc/palantir/missing.json' });
});

test('validateBinding does not inspect node filesystem for mcp_config_path only', async () => {
  const executor = createFakeExecutor();
  const nodeService = createFakeNodeService(executor);
  const validator = createNodeBindingValidator({
    nodeService,
    fs: createFakeFs(['/control/mcp.json']),
  });

  await validator.validateBinding({ nodeId: 'node-a', mcpConfigPath: '/control/mcp.json' });

  assert.deepEqual(nodeService.calls, []);
  assert.deepEqual(executor.calls.realpath, []);
  assert.deepEqual(executor.calls.fileExists, []);
});

test('validateBinding trims the directory before validating (NIT: leading/trailing space)', async () => {
  const executor = createFakeExecutor();
  const nodeService = createFakeNodeService(executor);
  const validator = createNodeBindingValidator({ nodeService, fs: createFakeFs() });

  await validator.validateBinding({ nodeId: 'node-a', directory: '  /srv/repo  ' });

  assert.deepEqual(executor.calls.realpath, ['/srv/repo']);
});
