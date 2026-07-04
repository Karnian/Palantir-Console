const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough, Writable } = require('node:stream');

const { createNodeUsageService, ERROR_CODES } = require('../services/nodeUsageService');
const { createNodesRouter } = require('../routes/nodes');
const { NotFoundError } = require('../utils/errors');

class FakeChild extends EventEmitter {
  constructor({
    stdout = '',
    stderr = '',
    code = 0,
    autoClose = true,
    onLine = null,
    onFinal = null,
    ignoreSigterm = false,
  } = {}) {
    super();
    this.stdout = new PassThrough();
    this.stderr = new PassThrough();
    this.killedSignals = [];
    this.closed = false;
    this.ignoreSigterm = ignoreSigterm;
    this.onFinal = onFinal;
    this.lineBuffer = '';
    this.stdin = new Writable({
      write: (chunk, enc, cb) => {
        this.lineBuffer += chunk.toString('utf8');
        let index;
        while ((index = this.lineBuffer.indexOf('\n')) !== -1) {
          const line = this.lineBuffer.slice(0, index);
          this.lineBuffer = this.lineBuffer.slice(index + 1);
          if (onLine) onLine(line, this);
        }
        cb();
      },
      final: (cb) => {
        if (this.onFinal) this.onFinal(this);
        cb();
      },
    });

    if (autoClose) {
      process.nextTick(() => {
        if (stdout) this.stdout.write(stdout);
        if (stderr) this.stderr.write(stderr);
        this.close(code, null);
      });
    }
  }

  close(code = 0, signal = null) {
    if (this.closed) return;
    this.closed = true;
    this.stdout.end();
    this.stderr.end();
    this.emit('close', code, signal);
  }

  kill(signal = 'SIGTERM') {
    this.killedSignals.push(signal);
    if (signal === 'SIGTERM' && this.ignoreSigterm) return true;
    this.close(null, signal);
    return true;
  }
}

function makeExecutor(script) {
  const calls = [];
  return {
    calls,
    async spawnInteractive(command, args, opts) {
      calls.push({ command, args, opts });
      const key = `${command} ${args.join(' ')}`;
      const factory = script[key];
      if (!factory) throw new Error(`unexpected spawn: ${key}`);
      return factory();
    },
  };
}

function makeCodexAppServer(methods, { requiresOpenaiAuth = false } = {}) {
  return new FakeChild({
    autoClose: false,
    onLine(line, child) {
      const requestPayload = JSON.parse(line);
      methods.push(requestPayload.method);
      let response;
      if (requestPayload.method === 'initialize') {
        response = { jsonrpc: '2.0', id: requestPayload.id, result: {} };
      } else if (requestPayload.method === 'account/read') {
        response = {
          jsonrpc: '2.0',
          id: requestPayload.id,
          result: { account: { email: 'codex@example.test' }, requiresOpenaiAuth },
        };
      } else if (requestPayload.method === 'account/rateLimits/read') {
        response = {
          jsonrpc: '2.0',
          id: requestPayload.id,
          result: {
            rateLimits: {
              primary: {
                remaining_pct: 42,
                resets_at: '2026-07-05T00:00:00.000Z',
                windowDurationMins: 300,
              },
            },
          },
        };
      } else {
        response = { jsonrpc: '2.0', id: requestPayload.id, error: { message: 'unexpected' } };
      }
      child.stdout.write(`${JSON.stringify(response)}\n`);
    },
    onFinal(child) {
      process.nextTick(() => child.close(0, null));
    },
  });
}

function assertCardShape(cli) {
  assert.deepEqual(Object.keys(cli).sort(), [
    'authStatus',
    'error',
    'id',
    'installed',
    'updatedAt',
    'usage',
    'version',
  ].sort());
  assert.equal(typeof cli.id, 'string');
  assert.equal(typeof cli.updatedAt, 'string');
  if (cli.error) {
    assert.ok(ERROR_CODES.has(cli.error.code), `unexpected error code ${cli.error.code}`);
    assert.equal(typeof cli.error.message, 'string');
  }
}

test('local node usage wraps registered providers in wire-locked cards', async () => {
  const service = createNodeUsageService({
    nodeService: {
      getNode(id) {
        assert.equal(id, 'local');
        return { id: 'local', name: 'Local', kind: 'local', reachable: 1 };
      },
    },
    providerRegistry: {
      async fetchAllRegistered() {
        return [
          {
            id: 'codex',
            limits: [{ label: 'weekly limit', remainingPct: 88, resetAt: null }],
            account: { email: 'local@example.test' },
            updatedAt: '2026-07-04T00:00:00.000Z',
          },
          {
            id: 'anthropic',
            limits: [{ label: 'usage', remainingPct: null, resetAt: null }],
            updatedAt: '2026-07-04T00:00:01.000Z',
          },
          {
            id: 'google',
            limits: [{ label: 'usage', remainingPct: 50, resetAt: null }],
            updatedAt: '2026-07-04T00:00:02.000Z',
          },
        ];
      },
    },
  });

  const snapshot = await service.getUsageSnapshot('local');

  assert.deepEqual(snapshot.node, { id: 'local', name: 'Local', kind: 'local', reachable: 1 });
  assert.deepEqual(snapshot.clis.map((item) => item.id), ['codex', 'claude', 'gemini']);
  for (const cli of snapshot.clis) assertCardShape(cli);
  assert.equal(snapshot.clis[0].installed, true);
  assert.equal(snapshot.clis[0].usage.account.email, 'local@example.test');
  assert.equal(snapshot.clis[1].error, null);
});

test('local claude card is augmented from the claude-code adapter when the registry lacks it', async () => {
  // The registry's registered set = opencode auth.json keys — a keychain-authed
  // local claude CLI is invisible to it. Node semantics are "CLIs on this
  // node", so getLocalCards asks the claude-code adapter directly.
  let fetchCalls = 0;
  const service = createNodeUsageService({
    nodeService: {
      getNode() { return { id: 'local', name: 'Local', kind: 'local', reachable: 1 }; },
    },
    providerRegistry: {
      async fetchAllRegistered() {
        return [{ id: 'codex', limits: [{ label: 'weekly limit', remainingPct: 88, resetAt: null }], updatedAt: '2026-07-04T00:00:00.000Z' }];
      },
    },
    fetchClaudeCodeFn: async () => {
      fetchCalls += 1;
      return {
        id: 'anthropic',
        name: 'claude',
        limits: [{ label: '5h limit', remainingPct: 61, resetAt: null }],
        account: { email: 'claude-local@example.test', planType: 'max' },
        updatedAt: '2026-07-04T00:00:03.000Z',
      };
    },
  });

  const snapshot = await service.getUsageSnapshot('local');
  assert.equal(fetchCalls, 1);
  assert.deepEqual(snapshot.clis.map((item) => item.id), ['codex', 'claude']);
  const claude = snapshot.clis.find((item) => item.id === 'claude');
  assertCardShape(claude);
  assert.equal(claude.error, null);
  assert.equal(claude.usage.limits[0].remainingPct, 61);
  assert.equal(claude.usage.account.email, 'claude-local@example.test');
});

test('local claude augmentation failure degrades to a no_data card, not a route error', async () => {
  const service = createNodeUsageService({
    nodeService: {
      getNode() { return { id: 'local', name: 'Local', kind: 'local', reachable: 1 }; },
    },
    providerRegistry: {
      async fetchAllRegistered() { return []; },
    },
    fetchClaudeCodeFn: async () => { throw new Error('keychain unavailable'); },
  });

  const snapshot = await service.getUsageSnapshot('local');
  const claude = snapshot.clis.find((item) => item.id === 'claude');
  assertCardShape(claude);
  assert.equal(claude.error.code, 'no_data');
});

test('local provider errors stay per-card and node misses remain 404 errors', async () => {
  const nodeService = {
    getNode(id) {
      if (id === 'missing') throw new NotFoundError('Node not found: missing');
      return { id, name: 'Local', kind: 'local', reachable: 1 };
    },
  };
  const service = createNodeUsageService({
    nodeService,
    providerRegistry: {
      async fetchAllRegistered() {
        throw new Error('No rate limit data available from local provider');
      },
    },
  });

  const snapshot = await service.getUsageSnapshot('local');
  assert.deepEqual(snapshot.clis.map((item) => item.error.code), ['no_data', 'no_data', 'no_data']);

  await assert.rejects(
    () => service.getUsageSnapshot('missing'),
    (err) => err.status === 404,
  );
});

test('nodes usage route is registered before the parameter route', () => {
  const router = createNodesRouter({
    nodeService: { listNodes() { return []; }, getNode() { return {}; } },
    nodeUsageService: { async getUsageSnapshot() { return {}; } },
  });
  const paths = router.stack.filter((layer) => layer.route).map((layer) => layer.route.path);

  assert.ok(paths.indexOf('/:id/usage') !== -1, 'usage route registered');
  assert.ok(paths.indexOf('/:id') !== -1, 'id route registered');
  assert.ok(paths.indexOf('/:id/usage') < paths.indexOf('/:id'), 'usage route precedes id route');
});

test('ssh node usage probes fixed commands with empty env, pathPrefix, RPC sequence, and auth allowlist', async () => {
  const rpcMethods = [];
  const executor = makeExecutor({
    'codex --version': () => new FakeChild({ stdout: 'codex-cli 0.140.0\n' }),
    'codex app-server': () => makeCodexAppServer(rpcMethods),
    'claude --version': () => new FakeChild({ stdout: '2.1.179\n' }),
    'claude auth status': () => new FakeChild({
      stdout: `${JSON.stringify({
        loggedIn: true,
        email: 'claude@example.test',
        planType: 'max',
        orgName: 'Acme',
        accessToken: 'secret-that-must-drop',
      })}\n`,
    }),
  });
  const node = {
    id: 'pod-a',
    name: 'Pod A',
    kind: 'ssh',
    reachable: 1,
    node_prefix: '/home/agent/.npm-global/bin',
  };
  const service = createNodeUsageService({
    nodeService: {
      getNode() { return node; },
      pickExecutor(id) {
        assert.equal(id, 'pod-a');
        return executor;
      },
    },
    providerRegistry: null,
  });

  const snapshot = await service.getUsageSnapshot('pod-a');
  const codex = snapshot.clis.find((item) => item.id === 'codex');
  const claude = snapshot.clis.find((item) => item.id === 'claude');

  assert.deepEqual(rpcMethods, ['initialize', 'account/read', 'account/rateLimits/read']);
  assert.equal(codex.installed, true);
  assert.equal(codex.version, 'codex-cli 0.140.0');
  assert.equal(codex.error, null);
  assert.equal(codex.usage.limits[0].remainingPct, 42);
  assert.equal(codex.usage.account.email, 'codex@example.test');
  assert.equal(claude.installed, true);
  assert.equal(claude.version, '2.1.179');
  assert.deepEqual(claude.authStatus, {
    loggedIn: true,
    email: 'claude@example.test',
    planType: 'max',
    orgName: 'Acme',
  });
  assert.equal(claude.error.code, 'quota_unsupported');

  assert.deepEqual(new Set(executor.calls.map((call) => `${call.command} ${call.args.join(' ')}`)), new Set([
    'codex --version',
    'claude --version',
    'codex app-server',
    'claude auth status',
  ]));
  for (const call of executor.calls) {
    assert.deepEqual(call.opts.env, {});
    assert.equal(call.opts.pathPrefix, '/home/agent/.npm-global/bin');
  }
});

test('ssh codex requiresOpenaiAuth=true passes through as data, not not_logged_in', async () => {
  // Real-Pi regression: a ChatGPT-plan pod login returns requiresOpenaiAuth=true
  // alongside valid rate limits. The probe must mirror local codexService
  // semantics (pass-through field), not degrade the card to not_logged_in.
  const rpcMethods = [];
  const executor = makeExecutor({
    'codex --version': () => new FakeChild({ stdout: 'codex-cli 0.140.0\n' }),
    'codex app-server': () => makeCodexAppServer(rpcMethods, { requiresOpenaiAuth: true }),
    'claude --version': () => new FakeChild({ stdout: '2.1.179\n' }),
    'claude auth status': () => new FakeChild({ stdout: `${JSON.stringify({ loggedIn: true })}\n` }),
  });
  const node = { id: 'pod-a', name: 'Pod A', kind: 'ssh', reachable: 1 };
  const service = createNodeUsageService({
    nodeService: {
      getNode() { return node; },
      pickExecutor() { return executor; },
    },
    providerRegistry: null,
  });

  const snapshot = await service.getUsageSnapshot('pod-a');
  const codex = snapshot.clis.find((item) => item.id === 'codex');
  assert.equal(codex.error, null);
  assert.equal(codex.usage.requiresOpenaiAuth, true);
  assert.equal(codex.usage.limits[0].remainingPct, 42);
});

test('ssh unreachable nodes fail soft without spawning', async () => {
  const node = { id: 'pod-down', name: 'Pod Down', kind: 'ssh', reachable: 0 };
  const service = createNodeUsageService({
    nodeService: {
      getNode() { return node; },
      pickExecutor() { throw new Error('must not spawn for unreachable nodes'); },
    },
  });

  const snapshot = await service.getUsageSnapshot('pod-down');
  assert.deepEqual(snapshot.clis.map((item) => item.error.code), ['transport_lost', 'transport_lost']);
  assert.deepEqual(snapshot.clis.map((item) => item.error.message), ['node unreachable', 'node unreachable']);
});

test('ssh version exit 127 maps to not_installed', async () => {
  const executor = makeExecutor({
    'codex --version': () => new FakeChild({ code: 127 }),
    'claude --version': () => new FakeChild({ code: 127 }),
  });
  const service = createNodeUsageService({
    nodeService: {
      getNode() { return { id: 'pod', name: 'Pod', kind: 'ssh', reachable: 1 }; },
      pickExecutor() { return executor; },
    },
  });

  const snapshot = await service.getUsageSnapshot('pod');
  for (const cli of snapshot.clis) {
    assert.equal(cli.installed, false);
    assert.equal(cli.error.code, 'not_installed');
  }
});

test('ssh timeout sends SIGTERM then escalates to SIGKILL', async () => {
  const hangingChild = new FakeChild({ autoClose: false, ignoreSigterm: true });
  const executor = makeExecutor({
    'codex --version': () => hangingChild,
    'claude --version': () => new FakeChild({ code: 127 }),
  });
  const service = createNodeUsageService({
    nodeService: {
      getNode() { return { id: 'pod', name: 'Pod', kind: 'ssh', reachable: 1 }; },
      pickExecutor() { return executor; },
    },
    probeTimeoutMs: 5,
    probeKillGraceMs: 5,
  });

  const snapshot = await service.getUsageSnapshot('pod');
  const codex = snapshot.clis.find((item) => item.id === 'codex');

  assert.equal(codex.error.code, 'timeout');
  assert.ok(hangingChild.killedSignals.includes('SIGTERM'));
  assert.ok(hangingChild.killedSignals.includes('SIGKILL'));
});

test('ssh exit 255 maps to transport_lost and output cap maps to probe_failed', async () => {
  const capChild = new FakeChild({ stdout: '0123456789abcdef\n' });
  const executor = makeExecutor({
    'codex --version': () => new FakeChild({ code: 255 }),
    'claude --version': () => capChild,
  });
  const service = createNodeUsageService({
    nodeService: {
      getNode() { return { id: 'pod', name: 'Pod', kind: 'ssh', reachable: 1 }; },
      pickExecutor() { return executor; },
    },
    probeMaxOutputBytes: 4,
  });

  const snapshot = await service.getUsageSnapshot('pod');
  const codex = snapshot.clis.find((item) => item.id === 'codex');
  const claude = snapshot.clis.find((item) => item.id === 'claude');

  assert.equal(codex.error.code, 'transport_lost');
  assert.equal(claude.error.code, 'probe_failed');
  assert.ok(capChild.killedSignals.includes('SIGTERM'));
});

test('output cap is combined across stdout and stderr', async () => {
  // 3 bytes stdout + 3 bytes stderr with a 5-byte cap: neither stream alone
  // crosses the cap — only the combined total does (Codex R2 finding 1).
  const child = new FakeChild({ autoClose: false });
  process.nextTick(() => {
    child.stdout.write('abc');
    child.stderr.write('def');
  });
  const executor = makeExecutor({
    'codex --version': () => child,
    'claude --version': () => new FakeChild({ code: 127 }),
  });
  const service = createNodeUsageService({
    nodeService: {
      getNode() { return { id: 'pod', name: 'Pod', kind: 'ssh', reachable: 1 }; },
      pickExecutor() { return executor; },
    },
    probeMaxOutputBytes: 5,
    probeKillGraceMs: 5,
  });

  const snapshot = await service.getUsageSnapshot('pod');
  const codex = snapshot.clis.find((item) => item.id === 'codex');
  assert.equal(codex.error.code, 'probe_failed');
  assert.ok(child.killedSignals.includes('SIGTERM'));
});

test('spawn-side throw maps to probe_failed, not not_installed', async () => {
  // A local/transport-side failure (spawnInteractive throwing, e.g. invalid
  // pathPrefix) proves nothing about the remote CLI's presence (R2 finding 4).
  const executor = {
    async spawnInteractive() { throw new Error('spawnInteractive pathPrefix must be an absolute POSIX path'); },
  };
  const service = createNodeUsageService({
    nodeService: {
      getNode() { return { id: 'pod', name: 'Pod', kind: 'ssh', reachable: 1 }; },
      pickExecutor() { return executor; },
    },
  });

  const snapshot = await service.getUsageSnapshot('pod');
  for (const cli of snapshot.clis) {
    assert.equal(cli.error.code, 'probe_failed');
    assert.notEqual(cli.installed, false);
  }
});

test('pickExecutor throw stays a per-card error, not an HTTP-level throw', async () => {
  const service = createNodeUsageService({
    nodeService: {
      getNode() { return { id: 'pod', name: 'Pod', kind: 'ssh', reachable: 1 }; },
      pickExecutor() { throw new Error('SSH node pod has invalid exposed_roots JSON'); },
    },
  });

  const snapshot = await service.getUsageSnapshot('pod');
  assert.deepEqual(snapshot.clis.map((item) => item.id), ['codex', 'claude']);
  for (const cli of snapshot.clis) {
    assertCardShape(cli);
    assert.equal(cli.error.code, 'probe_failed');
  }
});

test('remote accountError is sanitized to a message-only object', async () => {
  const rpcMethods = [];
  const child = new FakeChild({
    autoClose: false,
    onLine(line, c) {
      const req = JSON.parse(line);
      rpcMethods.push(req.method);
      let response;
      if (req.method === 'initialize') {
        response = { jsonrpc: '2.0', id: req.id, result: {} };
      } else if (req.method === 'account/read') {
        response = {
          jsonrpc: '2.0',
          id: req.id,
          error: { message: 'auth exploded Bearer abc.def internal', data: { stack: 'secret-stack' }, code: -32000 },
        };
      } else {
        response = {
          jsonrpc: '2.0',
          id: req.id,
          result: { rateLimits: { primary: { remaining_pct: 7, windowDurationMins: 300 } } },
        };
      }
      c.stdout.write(`${JSON.stringify(response)}\n`);
    },
    onFinal(c) { process.nextTick(() => c.close(0, null)); },
  });
  const executor = makeExecutor({
    'codex --version': () => new FakeChild({ stdout: 'codex-cli 0.140.0\n' }),
    'codex app-server': () => child,
    'claude --version': () => new FakeChild({ code: 127 }),
  });
  const service = createNodeUsageService({
    nodeService: {
      getNode() { return { id: 'pod', name: 'Pod', kind: 'ssh', reachable: 1 }; },
      pickExecutor() { return executor; },
    },
  });

  const snapshot = await service.getUsageSnapshot('pod');
  const codex = snapshot.clis.find((item) => item.id === 'codex');
  assert.equal(codex.error, null);
  assert.deepEqual(Object.keys(codex.usage.accountError), ['message']);
  assert.ok(!codex.usage.accountError.message.includes('abc.def'));
  assert.ok(!JSON.stringify(codex.usage).includes('secret-stack'));
});
