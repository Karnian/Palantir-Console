const test = require('node:test');
const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createTmuxEngine } = require('../services/executionEngine');

let sequence = 0;

function artifactPaths(tmpDir, runId) {
  const name = `palantir-run-${runId}`.replace(/[^a-zA-Z0-9_-]/g, '_');
  const scriptDir = path.join(tmpDir, 'palantir-scripts');
  return {
    name,
    scriptDir,
    scriptPath: path.join(scriptDir, `${name}.sh`),
    stdinPath: path.join(scriptDir, `${name}.stdin`),
    exitPath: path.join(scriptDir, `${name}.exit`),
    exitTmpPath: path.join(scriptDir, `${name}.exit.tmp`),
    startedPath: path.join(scriptDir, `${name}.started`),
  };
}

function isolatedTmux(t, { requireServer = true } = {}) {
  sequence += 1;
  const previous = {
    TMPDIR: process.env.TMPDIR,
    TMUX_TMPDIR: process.env.TMUX_TMPDIR,
    TMUX: process.env.TMUX,
  };
  // tmux's Unix socket path has a small platform limit. Keep both the sandbox
  // and dedicated server label short while staying under the suite TMPDIR.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'p-'));
  const tmpDir = path.join(root, 'tmp');
  const tmuxTmpDir = path.join(root, 'tmux');
  fs.mkdirSync(tmpDir);
  fs.mkdirSync(tmuxTmpDir, { mode: 0o700 });
  process.env.TMPDIR = tmpDir;
  process.env.TMUX_TMPDIR = tmuxTmpDir;
  delete process.env.TMUX;

  const socket = `p${sequence}`;
  const env = {
    ...process.env,
    TMPDIR: tmpDir,
    TMUX_TMPDIR: tmuxTmpDir,
    SHELL: '/bin/bash',
  };
  delete env.TMUX;
  const command = (executable, args, options = {}) => {
    const actualArgs = executable === 'tmux'
      ? ['-f', '/dev/null', '-L', socket, ...args]
      : args;
    return childProcess.execFileSync(executable, actualArgs, {
      ...options,
      env,
    });
  };
  t.after(() => {
    try { command('tmux', ['kill-server'], { stdio: 'pipe' }); } catch {}
    if (previous.TMPDIR === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = previous.TMPDIR;
    if (previous.TMUX_TMPDIR === undefined) delete process.env.TMUX_TMPDIR;
    else process.env.TMUX_TMPDIR = previous.TMUX_TMPDIR;
    if (previous.TMUX === undefined) delete process.env.TMUX;
    else process.env.TMUX = previous.TMUX;
    fs.rmSync(root, { recursive: true, force: true });
  });

  // These are intentionally real tmux tests. Some restricted test sandboxes
  // allow executing tmux but forbid creating Unix sockets; skip only in that
  // environment, while normal CI/dev hosts exercise the dedicated server.
  try {
    command('tmux', ['-V'], { stdio: 'pipe' });
    if (!requireServer) {
      return {
        command,
        engine: createTmuxEngine({ execFileSync: command }),
        tmpDir,
      };
    }
    command('tmux', ['new-session', '-d', '-s', '__palantir_probe'], { stdio: 'pipe' });
    command('tmux', ['has-session', '-t', '__palantir_probe'], { stdio: 'pipe' });
    command('tmux', ['kill-session', '-t', '__palantir_probe'], { stdio: 'pipe' });
  } catch (error) {
    t.skip(`dedicated tmux server unavailable: ${error.message}`);
    return null;
  }

  return {
    command,
    engine: createTmuxEngine({ execFileSync: command }),
    tmpDir,
  };
}

function writeStartupArtifacts(paths, { sentinel = false } = {}) {
  fs.mkdirSync(paths.scriptDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(paths.scriptPath, '#!/bin/bash\n', { mode: 0o700 });
  fs.writeFileSync(paths.stdinPath, 'sensitive prompt\n', { mode: 0o600 });
  if (sentinel) fs.writeFileSync(paths.exitPath, '0\n', { mode: 0o600 });
}

async function waitFor(predicate, message) {
  const deadline = Date.now() + 3000;
  while (!predicate() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.ok(predicate(), message);
}

test('state 1: queued/running run with no tmux session reaps .sh and .stdin', (t) => {
  const runId = `queued-no-session-${process.pid}`;
  const h = isolatedTmux(t, { requireServer: false });
  if (!h) return;
  const paths = artifactPaths(h.tmpDir, runId);
  writeStartupArtifacts(paths);

  const result = h.engine.reapStartupArtifacts(runId);

  assert.equal(result.action, 'removed');
  assert.equal(result.reason, 'no_session');
  assert.equal(fs.existsSync(paths.scriptPath), false);
  assert.equal(fs.existsSync(paths.stdinPath), false);
});

test('state 2: running DB run with pre-send-keys empty tmux shell is not reattached', (t) => {
  const runId = `running-empty-shell-${process.pid}`;
  const h = isolatedTmux(t);
  if (!h) return;
  const paths = artifactPaths(h.tmpDir, runId);
  writeStartupArtifacts(paths);
  h.command('tmux', ['new-session', '-d', '-s', paths.name, '-c', h.tmpDir], { stdio: 'pipe' });

  const result = h.engine.reapStartupArtifacts(runId);

  assert.equal(result.action, 'removed');
  assert.equal(result.reason, 'idle_shell');
  assert.equal(h.engine.isAlive(runId), false, 'empty shell must not survive for recovery');
  assert.equal(fs.existsSync(paths.scriptPath), false);
  assert.equal(fs.existsSync(paths.stdinPath), false);
});

test('state 3: running tmux worker and its .sh/.stdin are preserved', async (t) => {
  const runId = `running-worker-${process.pid}`;
  const h = isolatedTmux(t);
  if (!h) return;
  const paths = artifactPaths(h.tmpDir, runId);
  t.after(() => h.engine.kill(runId));

  h.engine.spawnAgent(runId, {
    command: process.execPath,
    args: ['-e', 'setTimeout(() => {}, 30000)'],
    stdin: 'keep this prompt while the worker runs\n',
    cwd: h.tmpDir,
    env: {},
  });
  await waitFor(() => fs.existsSync(paths.startedPath), 'worker start marker was not published');

  const result = h.engine.reapStartupArtifacts(runId);

  assert.deepEqual(result, { action: 'preserved', reason: 'running', removed: [] });
  assert.equal(h.engine.isAlive(runId), true);
  assert.equal(fs.existsSync(paths.scriptPath), true);
  assert.equal(fs.existsSync(paths.stdinPath), true);
});

test('state 4: terminal run with sentinel and no tmux session reaps all artifacts', (t) => {
  const runId = `terminal-sentinel-${process.pid}`;
  const h = isolatedTmux(t, { requireServer: false });
  if (!h) return;
  const paths = artifactPaths(h.tmpDir, runId);
  writeStartupArtifacts(paths, { sentinel: true });

  const result = h.engine.reapStartupArtifacts(runId);

  assert.equal(result.action, 'removed');
  assert.equal(result.reason, 'no_session');
  assert.equal(fs.existsSync(paths.scriptPath), false);
  assert.equal(fs.existsSync(paths.stdinPath), false);
  assert.equal(fs.existsSync(paths.exitPath), false);
});
