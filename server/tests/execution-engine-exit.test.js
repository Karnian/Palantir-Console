const test = require('node:test');
const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createTmuxEngine } = require('../services/executionEngine');

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

test('kill cleans script and sentinel artifacts even when the tmux session is already gone', (t) => {
  const runId = uniqueRunId('cleanup');
  const paths = artifactPaths(runId);
  fs.mkdirSync(path.dirname(paths.scriptPath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(paths.scriptPath, '#!/bin/bash\n');
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
  assert.equal(fs.existsSync(paths.sentinelPath), false);
  assert.equal(fs.existsSync(paths.sentinelTmpPath), false);
});
