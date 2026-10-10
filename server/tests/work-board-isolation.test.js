'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { EventEmitter } = require('node:events');
const { spawnSync } = require('node:child_process');

test('observe server environment isolates temp files, tmux, homes and credentials', t => {
  const roots = [];
  t.after(() => roots.forEach(root => fs.rmSync(root, { recursive: true, force: true })));
  const file = path.join(__dirname, 'helpers/observe-ui-server.cjs');
  const originalRequire = createRequire(file);
  const module = { exports: {} };
  // Prevent the old helper from starting a server during the RED check.
  const safeRequire = name => name === 'node:child_process' ? {
    spawn: () => new EventEmitter(),
  } : name === 'node:fs' ? { ...fs, mkdtempSync: prefix => {
    const root = fs.mkdtempSync(prefix); roots.push(root); return root;
  } } : originalRequire(name);
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), {
    require: safeRequire, module, __dirname: path.dirname(file), console,
    process: { env: process.env, execPath: process.execPath, on: () => {}, exit: () => {} },
  });
  assert.equal(typeof module.exports.createObserveEnvironment, 'function');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'work-board-env-')); roots.push(root);
  const host = { ...process.env, TMPDIR: '/host/temp', TMUX_TMPDIR: '/host/tmux',
    TMUX: '/host/tmux/default,123,0', TMUX_PANE: '%7', HOME: '/host/home',
    OPENAI_API_KEY: 'host-secret', PALANTIR_WORKER_TOKEN: 'host-token' };
  const env = module.exports.createObserveEnvironment(root, host);
  assert.equal(env.PORT, '4191');
  assert.ok(env.PALANTIR_TOKEN);
  for (const key of ['TMPDIR', 'TMUX_TMPDIR', 'HOME', 'CODEX_HOME', 'OPENCODE_STORAGE', 'PATH']) {
    assert.notEqual(env[key], host[key]);
    assert.ok(env[key].startsWith(`${root}${path.sep}`), key);
    assert.equal(fs.statSync(env[key]).isDirectory(), true, key);
    assert.equal(fs.statSync(env[key]).mode & 0o777, 0o700, key);
  }
  assert.notEqual(env.TMPDIR, env.TMUX_TMPDIR);
  for (const key of ['TMUX', 'TMUX_PANE', 'OPENAI_API_KEY', 'PALANTIR_WORKER_TOKEN']) {
    assert.equal(env[key], '', key);
  }
  assert.equal(env.PALANTIR_SKIP_HOST_CREDENTIALS, '1');
  assert.equal(env.PALANTIR_SKIP_DOTENV, '1');
  assert.equal(spawnSync('tmux', ['-V'], { env }).error.code, 'ENOENT');
});

test('legacy Playwright gates exclude observe projects and server unless explicitly enabled', () => {
  const file = path.resolve(__dirname, '../../playwright.config.js');
  const load = enabled => {
    const module = { exports: {} };
    vm.runInNewContext(fs.readFileSync(file, 'utf8'), {
      require: createRequire(file), module,
      process: { argv: ['node', 'playwright', 'test'], env: { PALANTIR_OBSERVE_UI: enabled } },
    });
    return module.exports;
  };
  const legacy = load('');
  assert.deepEqual(Array.from(legacy.projects, project => project.name), ['chromium', 'visual-chromium']);
  assert.deepEqual(Array.from(legacy.webServer, server => server.port), [4177, 4189]);
  const observe = load('1');
  assert.deepEqual(Array.from(observe.projects, project => project.name),
    ['chromium', 'visual-chromium', 'observe-setup', 'observe']);
  assert.equal(observe.webServer.at(-1).port, 4191);
  const pkg = require('../../package.json');
  assert.equal(pkg.scripts['test:observe-ui'],
    'PALANTIR_OBSERVE_UI=1 npx playwright test --project=observe-setup --project=observe');
});
