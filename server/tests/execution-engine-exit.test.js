const test = require('node:test');
const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createTmuxEngine, createSubprocessEngine } = require('../services/executionEngine');

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
  const markerIndex = script.indexOf('echo "___EXIT_CODE_${agent_exit_code}___"');
  const sentinelRenameIndex = script.indexOf('PATH="$__palantir_sentinel_publish_path" mv -f --');
  assert.notEqual(markerIndex, -1);
  assert.notEqual(sentinelRenameIndex, -1);
  assert.ok(markerIndex < sentinelRenameIndex, 'marker must be written before sentinel publication');

  const output = await runBash(paths.scriptPath);

  assert.equal(fs.readFileSync(paths.sentinelPath, 'utf-8'), '37\n');
  assert.equal(fs.existsSync(paths.sentinelTmpPath), false);
  assert.match(output, /___EXIT_CODE_37___/);
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
