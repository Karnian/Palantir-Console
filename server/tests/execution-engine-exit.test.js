const test = require('node:test');
const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  createTmuxEngine,
  createSubprocessEngine,
  cleanupStaleTmuxStartupArtifacts,
} = require('../services/executionEngine');

const fakeCodexPath = path.join(__dirname, 'fixtures', 'bin', 'fake-codex-stdin.js');

let runSequence = 0;

function uniqueRunId(label) {
  runSequence += 1;
  return `${label}-${process.pid}-${runSequence}`;
}

function artifactPaths(runId) {
  const name = `palantir-run-${runId}`.replace(/[^a-zA-Z0-9_-]/g, '_');
  const scriptDir = path.join(os.tmpdir(), 'palantir-scripts');
  return {
    scriptPath: path.join(scriptDir, `${name}.sh`),
    stdinPath: path.join(scriptDir, `${name}.stdin`),
    sentinelPath: path.join(scriptDir, `${name}.exit`),
    sentinelTmpPath: path.join(scriptDir, `${name}.exit.tmp`),
    startedPath: path.join(scriptDir, `${name}.started`),
  };
}

function writeSentinel(t, runId, value) {
  const { sentinelPath, sentinelTmpPath } = artifactPaths(runId);
  fs.mkdirSync(path.dirname(sentinelPath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(sentinelTmpPath, value);
  fs.renameSync(sentinelTmpPath, sentinelPath);
  t.after(() => {
    try { fs.unlinkSync(sentinelPath); } catch {}
    try { fs.unlinkSync(sentinelTmpPath); } catch {}
  });
  return sentinelPath;
}

function makeTmuxCommand({ captureOutput = null, killFails = false } = {}) {
  const calls = [];
  return {
    calls,
    execFileSync(command, args) {
      calls.push({ command, args });
      if (args[0] === 'capture-pane') {
        if (captureOutput === null) throw new Error('tmux session not found');
        return captureOutput;
      }
      if (args[0] === 'display-message') return 'bash\n';
      if (args[0] === 'kill-session' && killFails) throw new Error('tmux session not found');
      return '';
    },
  };
}

function runBash(scriptPath) {
  return new Promise((resolve, reject) => {
    execFile('/bin/bash', [scriptPath], { encoding: 'utf-8' }, (error, stdout) => {
      if (error) reject(error);
      else resolve(stdout);
    });
  });
}

test('pre-DB startup cleanup preserves run-owned prompts and removes capabilities only', (t) => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'palantir-startup-cleanup-'));
  const scriptDir = path.join(tmpRoot, 'palantir-scripts');
  const promptPath = path.join(scriptDir, 'palantir-run-crashed_worker.stdin');
  const scriptPath = path.join(scriptDir, 'palantir-run-crashed_worker.sh');
  const unrelatedPath = path.join(scriptDir, 'operator-notes.stdin');
  const tokenDir = path.join(scriptDir, '.worker-token-crashed');
  fs.mkdirSync(tokenDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(promptPath, 'sensitive prompt', { mode: 0o600 });
  fs.writeFileSync(scriptPath, '#!/bin/bash\n', { mode: 0o700 });
  fs.writeFileSync(unrelatedPath, 'keep me', { mode: 0o600 });
  fs.writeFileSync(path.join(tokenDir, 'token'), 'scoped capability', { mode: 0o600 });
  t.after(() => fs.rmSync(tmpRoot, { recursive: true, force: true }));

  assert.deepEqual(
    cleanupStaleTmuxStartupArtifacts({ tmpDir: tmpRoot }),
    { prompts: 0, capabilities: 1 },
  );
  assert.equal(fs.existsSync(promptPath), true, 'DB-aware lifecycle sweep owns prompt cleanup');
  assert.equal(fs.existsSync(tokenDir), false);
  assert.equal(fs.existsSync(scriptPath), true, 'non-secret diagnostic script is retained');
  assert.equal(fs.existsSync(unrelatedPath), true, 'non-Palantir stdin file is retained');
});

test('detectExitCode does not infer success from a running bash pane without a marker', () => {
  const tmux = makeTmuxCommand({ captureOutput: 'worker is still running\n' });
  const engine = createTmuxEngine({ execFileSync: tmux.execFileSync });

  assert.equal(engine.detectExitCode(uniqueRunId('running-bash')), null);
  assert.equal(tmux.calls.some(({ args }) => args[0] === 'display-message'), false);
});

test('detectExitCode returns zero from the durable sentinel after the session is gone', (t) => {
  const runId = uniqueRunId('sentinel-zero/unsafe');
  writeSentinel(t, runId, '0\n');
  const tmux = makeTmuxCommand();

  assert.equal(createTmuxEngine({ execFileSync: tmux.execFileSync }).detectExitCode(runId), 0);
  assert.equal(tmux.calls.length, 0);
});

test('detectExitCode returns a nonzero sentinel before a conflicting scrollback marker', (t) => {
  const tmux = makeTmuxCommand({ captureOutput: '___EXIT_CODE_0___\n' });
  const runId = uniqueRunId('sentinel-nonzero');
  writeSentinel(t, runId, '17\n');

  assert.equal(createTmuxEngine({ execFileSync: tmux.execFileSync }).detectExitCode(runId), 17);
  assert.equal(tmux.calls.length, 0);
});

test('detectExitCode keeps marker compatibility and ignores malformed sentinel content', (t) => {
  const tmux = makeTmuxCommand({ captureOutput: '___EXIT_CODE_23___\n' });
  const runId = uniqueRunId('marker-fallback');
  writeSentinel(t, runId, '23 trailing-data\n');

  assert.equal(createTmuxEngine({ execFileSync: tmux.execFileSync }).detectExitCode(runId), 23);
});

test('detectExitCode falls back to the marker for an out-of-range sentinel', (t) => {
  const tmux = makeTmuxCommand({ captureOutput: '___EXIT_CODE_41___\n' });
  const runId = uniqueRunId('out-of-range-marker-fallback');
  writeSentinel(t, runId, '999\n');

  assert.equal(createTmuxEngine({ execFileSync: tmux.execFileSync }).detectExitCode(runId), 41);
});

test('detectExitCode returns null for an out-of-range sentinel without a marker', (t) => {
  const tmux = makeTmuxCommand();
  const runId = uniqueRunId('out-of-range-no-marker');
  writeSentinel(t, runId, '999\n');

  assert.equal(createTmuxEngine({ execFileSync: tmux.execFileSync }).detectExitCode(runId), null);
});

test('detectExitCode returns null for a dead session with no sentinel or marker', () => {
  const tmux = makeTmuxCommand();
  assert.equal(
    createTmuxEngine({ execFileSync: tmux.execFileSync }).detectExitCode(uniqueRunId('dead-unknown')),
    null,
  );
});

test('spawnAgent publishes the sentinel when profile PATH excludes mv', async (t) => {
  const runId = uniqueRunId('restricted-path');
  const paths = artifactPaths(runId);
  t.after(() => {
    for (const filePath of Object.values(paths)) {
      try { fs.unlinkSync(filePath); } catch {}
    }
  });

  const tmux = makeTmuxCommand();
  createTmuxEngine({ execFileSync: tmux.execFileSync }).spawnAgent(runId, {
    command: process.execPath,
    args: ['-e', 'process.exit(37)'],
    cwd: os.tmpdir(),
    env: {
      PATH: path.join(os.tmpdir(), `${runId}-no-binaries`),
    },
  });

  const script = fs.readFileSync(paths.scriptPath, 'utf-8');
  const workerInvocation = script.split('\n').find((line) => line.startsWith('env -i '));
  const markerIndex = script.indexOf('echo "___EXIT_CODE_${agent_exit_code}___"');
  const sentinelRenameIndex = script.indexOf('PATH="$__palantir_sentinel_publish_path" mv -f --');
  assert.match(workerInvocation, /'PATH=\/opt\/homebrew\/bin:\/opt\/homebrew\/sbin:/);
  assert.match(workerInvocation, new RegExp(`${runId}-no-binaries`));
  assert.notEqual(markerIndex, -1);
  assert.notEqual(sentinelRenameIndex, -1);
  assert.ok(markerIndex < sentinelRenameIndex, 'marker must be written before sentinel publication');

  const output = await runBash(paths.scriptPath);

  assert.equal(fs.readFileSync(paths.sentinelPath, 'utf-8'), '37\n');
  assert.equal(fs.existsSync(paths.sentinelTmpPath), false);
  assert.match(output, /___EXIT_CODE_37___/);
});

test('spawnAgent clears stale tmux actor credentials and file-backs the current worker token', async (t) => {
  const runId = uniqueRunId('actor-env');
  const paths = artifactPaths(runId);
  t.after(() => {
    for (const filePath of Object.values(paths)) {
      try { fs.unlinkSync(filePath); } catch {}
    }
  });

  const tmux = makeTmuxCommand();
  createTmuxEngine({ execFileSync: tmux.execFileSync }).spawnAgent(runId, {
    command: process.execPath,
    args: ['--version'],
    cwd: os.tmpdir(),
    env: {
      PALANTIR_TOKEN: 'must-not-leak',
      PALANTIR_PM_TOKEN: 'must-not-leak-either',
      PALANTIR_WORKER_TOKEN: 'current-run-token',
    },
  });

  const script = fs.readFileSync(paths.scriptPath, 'utf-8');
  const unsetIndex = script.indexOf('unset PALANTIR_TOKEN PALANTIR_PM_TOKEN PALANTIR_WORKER_TOKEN PALANTIR_MANAGER_TOKEN');
  const cleanEnvIndex = script.indexOf('env -i ');
  const workerTokenIndex = script.indexOf('PALANTIR_WORKER_TOKEN="$__palantir_worker_token"');
  const tokenPathMatch = script.match(/__palantir_worker_token="\$\(cat -- '([^']+)'\)"/);
  assert.notEqual(unsetIndex, -1);
  assert.notEqual(cleanEnvIndex, -1);
  assert.notEqual(workerTokenIndex, -1);
  assert.ok(tokenPathMatch);
  assert.ok(unsetIndex < cleanEnvIndex);
  assert.ok(cleanEnvIndex < workerTokenIndex);
  assert.doesNotMatch(script, /'PALANTIR_TOKEN=/);
  assert.doesNotMatch(script, /'PALANTIR_PM_TOKEN=/);
  assert.doesNotMatch(script, /current-run-token/);
  assert.equal(fs.readFileSync(tokenPathMatch[1], 'utf-8'), 'current-run-token');

  await runBash(paths.scriptPath);
  assert.equal(fs.existsSync(tokenPathMatch[1]), false);
});

test('spawnAgent keeps the API base out of the env -i argv and drops it without a token', async (t) => {
  // `env -i KEY=value ...` puts every assignment into the env process's own
  // argv, which /proc exposes to other users on this host until it execs. The
  // remote path was fixed for exactly this; the local one runs the same risk.
  const apiBase = 'http://console.internal:4177';
  const withToken = uniqueRunId('api-base-filed');
  const withoutToken = uniqueRunId('api-base-unpaired');
  const paths = artifactPaths(withToken);
  const bare = artifactPaths(withoutToken);
  t.after(() => {
    for (const filePath of [...Object.values(paths), ...Object.values(bare)]) {
      try { fs.unlinkSync(filePath); } catch {}
    }
  });

  const tmux = makeTmuxCommand();
  const engine = createTmuxEngine({ execFileSync: tmux.execFileSync });
  engine.spawnAgent(withToken, {
    command: process.execPath,
    args: ['--version'],
    cwd: os.tmpdir(),
    env: { PALANTIR_WORKER_TOKEN: 'current-run-token', PALANTIR_API_BASE: apiBase },
  });

  const script = fs.readFileSync(paths.scriptPath, 'utf-8');
  const argvLine = script.split('\n').find((line) => line.startsWith('env -i '));
  assert.ok(argvLine);
  assert.equal(
    argvLine.includes(apiBase),
    false,
    'the value must never appear in the env -i argument list',
  );
  assert.ok(
    argvLine.includes('PALANTIR_API_BASE="$__palantir_api_base"'),
    'it must arrive expanded by the bootstrap shell instead',
  );
  const apiBasePathMatch = script.match(/__palantir_api_base="\$\(cat -- '([^']+)'\)"/);
  assert.ok(apiBasePathMatch);
  assert.equal(fs.readFileSync(apiBasePathMatch[1], 'utf-8'), apiBase);

  await runBash(paths.scriptPath);
  assert.equal(
    fs.existsSync(apiBasePathMatch[1]),
    false,
    'the bootstrap shell must unlink it before exec',
  );

  // The endpoint is only useful with a capability to present at it.
  engine.spawnAgent(withoutToken, {
    command: process.execPath,
    args: ['--version'],
    cwd: os.tmpdir(),
    env: { PALANTIR_API_BASE: apiBase },
  });
  const bareScript = fs.readFileSync(bare.scriptPath, 'utf-8');
  assert.equal(bareScript.includes(apiBase), false);
  assert.equal(bareScript.includes('PALANTIR_API_BASE'), false);
});

test('spawnAgent runs tmux workers without ambient server credentials', async (t) => {
  const runId = uniqueRunId('ambient-server-credential');
  const paths = artifactPaths(runId);
  const previous = process.env.CODEX_API_KEY;
  process.env.CODEX_API_KEY = 'ambient-server-secret-must-not-leak';
  t.after(() => {
    if (previous === undefined) delete process.env.CODEX_API_KEY;
    else process.env.CODEX_API_KEY = previous;
    for (const filePath of Object.values(paths)) {
      try { fs.unlinkSync(filePath); } catch {}
    }
  });

  const tmux = makeTmuxCommand();
  createTmuxEngine({ execFileSync: tmux.execFileSync }).spawnAgent(runId, {
    command: process.execPath,
    args: [
      '-e',
      "console.log(`${process.env.CODEX_API_KEY || 'missing'}|${process.env.SAFE_PROFILE_VALUE || 'missing'}`)",
    ],
    cwd: os.tmpdir(),
    env: { SAFE_PROFILE_VALUE: 'ok' },
  });

  const script = fs.readFileSync(paths.scriptPath, 'utf-8');
  assert.match(script, /env -i /);
  assert.match(script, /'SAFE_PROFILE_VALUE=ok'/);
  assert.doesNotMatch(script, /'CODEX_API_KEY=/);
  assert.doesNotMatch(script, /ambient-server-secret-must-not-leak/);
  const output = await runBash(paths.scriptPath);
  assert.match(output, /^missing\|ok$/m);
});

test('tmux worker feeds an option-like prompt through a mode-0600 stdin file, never argv or script', async (t) => {
  const runId = uniqueRunId('stdin-prompt');
  const prompt = '--- a/file.js\n-c service_tier="fast"\n--help\n';
  const paths = artifactPaths(runId);
  t.after(() => {
    for (const filePath of Object.values(paths)) {
      try { fs.unlinkSync(filePath); } catch {}
    }
  });

  const tmux = makeTmuxCommand();
  createTmuxEngine({ execFileSync: tmux.execFileSync }).spawnAgent(runId, {
    command: fakeCodexPath,
    args: ['exec', '-'],
    stdin: prompt,
    cwd: os.tmpdir(),
    env: {},
  });

  const script = fs.readFileSync(paths.scriptPath, 'utf-8');
  assert.doesNotMatch(script, /service_tier="fast"|--- a\/file\.js|--help/);
  assert.match(script, / < '.*\.stdin'/);
  assert.equal(fs.statSync(paths.stdinPath).mode & 0o777, 0o600);

  const output = await runBash(paths.scriptPath);
  const payload = JSON.parse(output.split('\n').find((line) => line.startsWith('{')));
  assert.deepEqual(payload.args, ['exec', '-']);
  assert.equal(payload.stdin, prompt);
  assert.equal(fs.existsSync(paths.stdinPath), false, 'stdin artifact is deleted after exit');
  assert.equal(fs.readFileSync(paths.sentinelPath, 'utf-8'), '0\n');
});

test('tmux worker stays valid shell when TMPDIR contains a single quote', async (t) => {
  // The trap body is evaluated twice (script parse, then handler run), so a
  // path quoted only once turns the handler into `unexpected EOF`. A quote in
  // TMPDIR is pathological but reachable — os.tmpdir() is env-derived — and a
  // broken handler silently strands prompt material on disk.
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'pal-quote-'));
  const nastyTmp = path.join(sandbox, "tmp'dir");
  fs.mkdirSync(nastyTmp, { recursive: true });
  const originalTmpDir = process.env.TMPDIR;
  process.env.TMPDIR = nastyTmp;
  t.after(() => {
    if (originalTmpDir === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = originalTmpDir;
    fs.rmSync(sandbox, { recursive: true, force: true });
  });

  const runId = uniqueRunId('stdin-quoted-tmpdir');
  const prompt = '--- a/file.js\n';
  const tmux = makeTmuxCommand();
  createTmuxEngine({ execFileSync: tmux.execFileSync }).spawnAgent(runId, {
    command: fakeCodexPath,
    args: ['exec', '-'],
    stdin: prompt,
    cwd: nastyTmp,
    env: {},
  });

  const paths = artifactPaths(runId);
  assert.ok(paths.scriptPath.includes("'"), 'the generated paths must actually contain a quote');

  // send-keys types into the pane's interactive shell — an unquoted path here
  // never starts the worker at all.
  const sendKeys = tmux.calls.find(({ args }) => args[0] === 'send-keys');
  assert.match(sendKeys.args[3], /^bash '.*'$/);
  assert.equal(sendKeys.args[4], 'Enter');

  const output = await runBash(paths.scriptPath);
  const payload = JSON.parse(output.split('\n').find((line) => line.startsWith('{')));
  assert.equal(payload.stdin, prompt);
  assert.equal(fs.existsSync(paths.stdinPath), false, 'normal-path cleanup removed the prompt');
  assert.equal(fs.readFileSync(paths.sentinelPath, 'utf-8'), '0\n');

  // The normal path disarms the trap before exiting, so exercise the handler
  // itself: arm it, fire EXIT, and require it to delete the right file.
  const script = fs.readFileSync(paths.scriptPath, 'utf-8');
  const trapLine = script.split('\n').find((line) => line.startsWith('trap '));
  assert.ok(trapLine, 'stdin worker installs a cleanup trap');
  fs.writeFileSync(paths.stdinPath, prompt, { mode: 0o600 });
  const trapProbe = path.join(nastyTmp, 'trap-probe.sh');
  fs.writeFileSync(
    trapProbe,
    `#!/bin/bash\n__palantir_sentinel_publish_path="$PATH"\n${trapLine}\nexit 0\n`,
    { mode: 0o700 },
  );
  await runBash(trapProbe);
  assert.equal(fs.existsSync(paths.stdinPath), false, 'trap handler removed the prompt file');
});

test('tmux worker removes a partially written stdin file when prompt persistence fails', (t) => {
  const runId = uniqueRunId('stdin-write-failure');
  const paths = artifactPaths(runId);
  t.after(() => {
    for (const filePath of Object.values(paths)) {
      try { fs.unlinkSync(filePath); } catch {}
    }
  });

  const tmux = makeTmuxCommand();
  const engine = createTmuxEngine({
    execFileSync: tmux.execFileSync,
    writeFileSync(filePath, data, options) {
      if (filePath === paths.stdinPath) {
        fs.writeFileSync(filePath, data.slice(0, 4), options);
        const error = new Error('simulated partial stdin write');
        error.code = 'ENOSPC';
        throw error;
      }
      fs.writeFileSync(filePath, data, options);
    },
  });

  assert.throws(
    () => engine.spawnAgent(runId, {
      command: fakeCodexPath,
      args: ['exec', '-'],
      stdin: '--help\n',
      cwd: os.tmpdir(),
      env: {},
    }),
    (error) => error.code === 'ENOSPC',
  );
  assert.equal(fs.existsSync(paths.stdinPath), false);
  assert.equal(tmux.calls.length, 0, 'tmux must not start after stdin persistence fails');
});

test('tmux worker leaves no prompt or capability artifact when token persistence fails', (t) => {
  const runId = uniqueRunId('token-write-failure');
  const paths = artifactPaths(runId);
  let failedTokenPath = null;
  t.after(() => {
    for (const filePath of Object.values(paths)) {
      try { fs.unlinkSync(filePath); } catch {}
    }
    if (failedTokenPath) {
      try { fs.unlinkSync(failedTokenPath); } catch {}
      try { fs.rmdirSync(path.dirname(failedTokenPath)); } catch {}
    }
  });

  const tmux = makeTmuxCommand();
  const engine = createTmuxEngine({
    execFileSync: tmux.execFileSync,
    writeFileSync(filePath, data, options) {
      if (path.basename(filePath) === 'token' && filePath.includes('.worker-token-')) {
        failedTokenPath = filePath;
        fs.writeFileSync(filePath, data.slice(0, 4), options);
        const error = new Error('simulated partial token write');
        error.code = 'ENOSPC';
        throw error;
      }
      fs.writeFileSync(filePath, data, options);
    },
  });

  assert.throws(
    () => engine.spawnAgent(runId, {
      command: fakeCodexPath,
      args: ['exec', '-'],
      stdin: 'sensitive prompt\n',
      cwd: os.tmpdir(),
      env: { PALANTIR_WORKER_TOKEN: 'scoped-worker-capability' },
    }),
    (error) => error.code === 'ENOSPC',
  );
  assert.ok(failedTokenPath);
  assert.equal(fs.existsSync(paths.stdinPath), false);
  assert.equal(fs.existsSync(failedTokenPath), false);
  assert.equal(fs.existsSync(path.dirname(failedTokenPath)), false);
  assert.equal(tmux.calls.length, 0, 'tmux must not start after token persistence fails');
});

test('subprocess worker writes the initial prompt to stdin and keeps it out of argv', async () => {
  const engine = createSubprocessEngine();
  const runId = uniqueRunId('subprocess-stdin');
  const prompt = '--help\n--- a/file.js\n';

  engine.spawnAgent(runId, {
    command: fakeCodexPath,
    args: ['exec', '-'],
    stdin: prompt,
    cwd: os.tmpdir(),
    env: {},
  });

  const deadline = Date.now() + 2000;
  while (engine.detectExitCode(runId) === null && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(engine.detectExitCode(runId), 0);
  const output = engine.getOutput(runId, 20);
  const payload = JSON.parse(output.split('\n').find((line) => line.startsWith('{')));
  assert.deepEqual(payload.args, ['exec', '-']);
  assert.equal(payload.stdin, prompt);
});

test('kill cleans script and sentinel artifacts even when the tmux session is already gone', (t) => {
  const runId = uniqueRunId('cleanup');
  const paths = artifactPaths(runId);
  fs.mkdirSync(path.dirname(paths.scriptPath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(paths.scriptPath, '#!/bin/bash\n');
  fs.writeFileSync(paths.stdinPath, 'secret prompt\n');
  fs.writeFileSync(paths.sentinelPath, '0\n');
  fs.writeFileSync(paths.sentinelTmpPath, '0\n');
  t.after(() => {
    for (const filePath of Object.values(paths)) {
      try { fs.unlinkSync(filePath); } catch {}
    }
  });

  const tmux = makeTmuxCommand({ killFails: true });
  createTmuxEngine({ execFileSync: tmux.execFileSync }).kill(runId);

  assert.equal(fs.existsSync(paths.scriptPath), false);
  assert.equal(fs.existsSync(paths.stdinPath), false);
  assert.equal(fs.existsSync(paths.sentinelPath), false);
  assert.equal(fs.existsSync(paths.sentinelTmpPath), false);
});

// ---------------------------------------------------------------------------
// #417 local startup state table.
//
// The remote half (state 5) and the SSH fail-safes were covered; these are the
// four local rows. Row 3 is the one that matters most — a sweep that reaps a
// LIVE worker is far worse than the leak it was written to fix — and row 2 is
// the case that made this issue worth filing: a session that exists but never
// got its send-keys looks alive to a naive check and gets reattached forever.
//
// The pane state is driven through the injected tmux command rather than a real
// server, so the classification is exercised without a tmux dependency.
// ---------------------------------------------------------------------------

function makeStateTmux({ sessionExists, panePid = null, psOutput = '' }) {
  const calls = [];
  return {
    calls,
    execFileSync(command, args) {
      calls.push({ command, args });
      if (command === 'ps') return psOutput;
      if (args[0] === 'has-session') {
        if (!sessionExists) throw new Error('no session');
        return '';
      }
      if (args[0] === 'display-message') {
        if (panePid === null) throw new Error('no pane');
        return `${panePid}\n`;
      }
      return '';
    },
  };
}

function seedArtifacts(t, runId, { started = false } = {}) {
  const paths = artifactPaths(runId);
  fs.mkdirSync(path.dirname(paths.scriptPath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(paths.scriptPath, '#!/bin/bash\ntrue\n', { mode: 0o700 });
  fs.writeFileSync(paths.stdinPath, 'prompt\n', { mode: 0o600 });
  if (started) fs.writeFileSync(paths.startedPath, '');
  t.after(() => {
    for (const p of Object.values(paths)) { try { fs.unlinkSync(p); } catch { /* ignore */ } }
  });
  return paths;
}

test('#417 state 1: no session, artifacts present -> reaped', (t) => {
  const runId = uniqueRunId('state1');
  const paths = seedArtifacts(t, runId);
  const tmux = makeStateTmux({ sessionExists: false });

  const result = createTmuxEngine({ execFileSync: tmux.execFileSync }).reapStartupArtifacts(runId);

  assert.equal(result.action, 'removed');
  assert.equal(result.reason, 'no_session');
  assert.equal(fs.existsSync(paths.scriptPath), false);
  assert.equal(fs.existsSync(paths.stdinPath), false, 'the prompt must not survive');
});

test('#417 state 2: idle shell (session up, send-keys never landed) -> killed and reaped', (t) => {
  const runId = uniqueRunId('state2');
  const paths = seedArtifacts(t, runId);
  // Pane exists and its process tree is just the shell — no worker was ever
  // started, so nothing here is worth preserving.
  const tmux = makeStateTmux({
    sessionExists: true,
    panePid: 424242,
    psOutput: '424242 1 -bash\n',
  });

  const engine = createTmuxEngine({ execFileSync: tmux.execFileSync });
  const result = engine.reapStartupArtifacts(runId);

  assert.equal(result.action, 'removed');
  assert.equal(result.reason, 'idle_shell');
  assert.equal(fs.existsSync(paths.stdinPath), false);
  assert.ok(
    tmux.calls.some(({ args }) => args[0] === 'kill-session'),
    'the ghost session must be killed so recovery cannot reattach it as a worker',
  );
});

test('#417 state 3: a RUNNING worker is preserved untouched', (t) => {
  const runId = uniqueRunId('state3');
  const paths = seedArtifacts(t, runId, { started: true });
  const tmux = makeStateTmux({
    sessionExists: true,
    panePid: 515151,
    psOutput: '515151 1 -bash\n515152 515151 codex exec -\n',
  });

  const result = createTmuxEngine({ execFileSync: tmux.execFileSync }).reapStartupArtifacts(runId);

  assert.equal(result.action, 'preserved');
  assert.equal(result.reason, 'running');
  assert.deepEqual(result.removed, []);
  assert.equal(fs.existsSync(paths.scriptPath), true, 'a live worker must keep its script');
  assert.equal(fs.existsSync(paths.stdinPath), true, 'a live worker must keep its prompt');
  assert.equal(
    tmux.calls.some(({ args }) => args[0] === 'kill-session'),
    false,
    'a live worker must never be killed by the sweep',
  );
});

test('#417 state 4: terminal run with a leftover sentinel -> reaped', (t) => {
  const runId = uniqueRunId('state4');
  const paths = seedArtifacts(t, runId);
  fs.writeFileSync(paths.sentinelPath, '0\n');
  const tmux = makeStateTmux({ sessionExists: false });

  const result = createTmuxEngine({ execFileSync: tmux.execFileSync }).reapStartupArtifacts(runId);

  assert.equal(result.action, 'removed');
  assert.ok(result.removed.includes(paths.sentinelPath));
  assert.equal(fs.existsSync(paths.sentinelPath), false);
});

test('#417 fail-safe: an unreadable pane is treated as uncertain and preserved', (t) => {
  // Local counterpart to the remote SSH fail-safes: if the engine cannot prove
  // the pane is idle, it must not delete anything.
  const runId = uniqueRunId('state-unknown');
  const paths = seedArtifacts(t, runId);
  const tmux = makeStateTmux({ sessionExists: true, panePid: null });

  const result = createTmuxEngine({ execFileSync: tmux.execFileSync }).reapStartupArtifacts(runId);

  assert.equal(result.action, 'preserved');
  assert.equal(result.reason, 'unknown');
  assert.equal(fs.existsSync(paths.stdinPath), true);
  assert.equal(tmux.calls.some(({ args }) => args[0] === 'kill-session'), false);
});
