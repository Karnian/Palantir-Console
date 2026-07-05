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
