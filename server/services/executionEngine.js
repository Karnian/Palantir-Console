const { execFileSync, execSync, spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { assertSpawnAllowed } = require('../utils/spawnGuard');
const {
  resolveActorTokenPolicy,
  buildWorkerProcessEnv,
  augmentProcessPath,
} = require('./actorTokenPolicy');

/**
 * ExecutionEngine abstraction — TmuxEngine (primary) + SubprocessEngine (fallback).
 * Manages agent process lifecycle: spawn, monitor, input, kill.
 *
 * SECURITY: All shell commands use execFileSync (argument arrays, no shell interpolation)
 * to prevent command injection. The only exception is the agent command itself, which
 * is written to a temporary script file to avoid any string interpolation in the shell.
 */

function detectTmux() {
  try {
    execFileSync('tmux', ['-V'], { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Validate a string is safe for use as a tmux session name.
 * Only allow alphanumeric, hyphens, underscores.
 */
function sanitizeSessionName(name) {
  return name.replace(/[^a-zA-Z0-9_-]/g, '_');
}

/**
 * Validate and sanitize a directory path.
 * Must be absolute and exist on disk.
 */
function validateCwd(dir) {
  const resolved = path.resolve(dir);
  if (!path.isAbsolute(resolved)) {
    throw new Error(`cwd must be an absolute path: ${dir}`);
  }
  if (!fs.existsSync(resolved)) {
    throw new Error(`cwd does not exist: ${dir}`);
  }
  return resolved;
}

// ---------- TmuxEngine ----------

function createTmuxEngine({
  execFileSync: runTmuxCommand = execFileSync,
  actorTokens = resolveActorTokenPolicy(),
} = {}) {
  const PATH_PREFIX = 'export PATH="/opt/homebrew/bin:/opt/homebrew/sbin:$PATH"';
  const tokenArtifacts = new Map();

  function sessionName(runId) {
    return sanitizeSessionName(`palantir-run-${runId}`);
  }

  function artifactPaths(runId) {
    const name = sessionName(runId);
    const scriptDir = path.join(os.tmpdir(), 'palantir-scripts');
    return {
      name,
      scriptDir,
      scriptPath: path.join(scriptDir, `${name}.sh`),
      exitSentinelPath: path.join(scriptDir, `${name}.exit`),
      exitSentinelTmpPath: path.join(scriptDir, `${name}.exit.tmp`),
    };
  }

  function cleanupTokenArtifact(runId) {
    const artifact = tokenArtifacts.get(runId);
    if (!artifact) return;
    try { fs.unlinkSync(artifact.tokenPath); } catch {}
    try { fs.rmdirSync(artifact.tokenDir); } catch {}
    tokenArtifacts.delete(runId);
  }

  function spawnAgent(runId, { command, args, cwd, env, outputLogPath }) {
    const {
      name,
      scriptDir,
      scriptPath,
      exitSentinelPath,
      exitSentinelTmpPath,
    } = artifactPaths(runId);
    const safeCwd = validateCwd(cwd);
    assertSpawnAllowed({ command, source: 'executionEngine:tmux' });

    // SECURITY: Write the agent command to a temp script file instead of
    // interpolating into a shell string. This eliminates all injection vectors.
    fs.mkdirSync(scriptDir, { recursive: true, mode: 0o700 });
    // A previous server/process crash may have left a result for this sanitized
    // session name. Never let a new worker inherit that stale exit code.
    try { fs.unlinkSync(exitSentinelPath); } catch {}
    try { fs.unlinkSync(exitSentinelTmpPath); } catch {}

    const profileEnv = buildWorkerProcessEnv(
      process.env,
      env && typeof env === 'object' ? env : {},
      actorTokens,
    );
    // PATH_PREFIX is required on macOS installations where the Console starts
    // with a restricted PATH but worker CLIs live under Homebrew. profileEnv
    // contains process.env.PATH, so exporting it unchanged below would silently
    // undo that prefix. Preserve the caller's PATH while keeping the required
    // lookup directories at the front.
    const augmentedProfileEnv = augmentProcessPath(
      profileEnv,
      ['/opt/homebrew/bin', '/opt/homebrew/sbin'],
    );
    // A worker capability must never be serialized into the long-lived tmux
    // script. Put it in a random mode-0600 file instead; the short bootstrap
    // shell reads and unlinks that file before exec. Capability issuance is
    // separately disabled unless the app has a verified OS/container process
    // boundary, but this keeps the transport one-shot as defense in depth.
    const workerToken = typeof augmentedProfileEnv.PALANTIR_WORKER_TOKEN === 'string'
      && augmentedProfileEnv.PALANTIR_WORKER_TOKEN
      ? augmentedProfileEnv.PALANTIR_WORKER_TOKEN
      : null;
    delete augmentedProfileEnv.PALANTIR_WORKER_TOKEN;
    cleanupTokenArtifact(runId);
    let tokenArtifact = null;
    if (workerToken) {
      const tokenDir = fs.mkdtempSync(path.join(scriptDir, '.worker-token-'));
      fs.chmodSync(tokenDir, 0o700);
      const tokenPath = path.join(tokenDir, 'token');
      try {
        fs.writeFileSync(tokenPath, workerToken, { flag: 'wx', mode: 0o600 });
      } catch (error) {
        try { fs.rmdirSync(tokenDir); } catch {}
        throw error;
      }
      tokenArtifact = { tokenDir, tokenPath };
      tokenArtifacts.set(runId, tokenArtifact);
    }
    let publishPathVar = '__palantir_sentinel_publish_path';
    while (Object.prototype.hasOwnProperty.call(augmentedProfileEnv, publishPathVar)) {
      publishPathVar += '_';
    }
    const lines = [
      '#!/bin/bash',
      PATH_PREFIX,
      `${publishPathVar}="$PATH"`,
      // A long-lived tmux server can retain credentials from an older Console
      // configuration. Clear actor tokens as defense-in-depth; the agent
      // command itself is launched with env -i below so no other inherited
      // server credential can cross the profile allowlist boundary either.
      'unset PALANTIR_TOKEN PALANTIR_PM_TOKEN PALANTIR_WORKER_TOKEN PALANTIR_MANAGER_TOKEN',
    ];
    if (tokenArtifact) {
      const safeTokenPath = tokenArtifact.tokenPath.replace(/'/g, "'\\''");
      const safeTokenDir = tokenArtifact.tokenDir.replace(/'/g, "'\\''");
      lines.push(`__palantir_worker_token="$(cat -- '${safeTokenPath}')" || exit 78`);
      lines.push(`rm -f -- '${safeTokenPath}'`);
      lines.push(`rmdir -- '${safeTokenDir}' 2>/dev/null || true`);
    }

    // Build an explicit clean environment for the worker. Merely exporting
    // profileEnv is insufficient because a long-lived tmux server may already
    // carry CODEX_API_KEY, ANTHROPIC_API_KEY, MCP bearer values, and other
    // credentials that are absent from the profile allowlist.
    const workerEnvArgs = [];
    for (const [k, v] of Object.entries(augmentedProfileEnv)) {
      if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(k)) continue;
      const safeAssignment = `${k}=${String(v)}`.replace(/'/g, "'\\''");
      workerEnvArgs.push(`'${safeAssignment}'`);
    }

    // Build command with proper quoting
    const quotedArgs = args.map(a => {
      const safeArg = String(a).replace(/'/g, "'\\''");
      return `'${safeArg}'`;
    });
    const safeCmd = String(command).replace(/'/g, "'\\''");
    const workerTokenAssignment = tokenArtifact
      ? ' PALANTIR_WORKER_TOKEN="$__palantir_worker_token"'
      : '';
    lines.push(`env -i ${workerEnvArgs.join(' ')}${workerTokenAssignment} '${safeCmd}' ${quotedArgs.join(' ')}`);
    // Capture $? exactly once so the durable sentinel and scrollback marker
    // always describe the same agent exit. Rename makes the sentinel atomic.
    const safeSentinel = exitSentinelPath.replace(/'/g, "'\\''");
    const safeSentinelTmp = exitSentinelTmpPath.replace(/'/g, "'\\''");
    lines.push('agent_exit_code=$?');
    lines.push(`printf '%s\\n' "$agent_exit_code" > '${safeSentinelTmp}'`);
    lines.push('echo "___EXIT_CODE_${agent_exit_code}___"');
    lines.push(`PATH="$${publishPathVar}" mv -f -- '${safeSentinelTmp}' '${safeSentinel}'`);

    try {
      fs.writeFileSync(scriptPath, lines.join('\n') + '\n', { mode: 0o700 });
    } catch (error) {
      cleanupTokenArtifact(runId);
      throw error;
    }

    try {
      // Create tmux session — all args passed as array (no shell interpolation)
      runTmuxCommand('tmux', ['new-session', '-d', '-s', name, '-c', safeCwd], {
        stdio: 'pipe',
      });

      // G1: optional file-backed tee (§5k-2). pipe-pane duplicates the pane's
      // output to a file so a goal worker's final output is durable (restart-safe,
      // not just in the volatile pane scrollback). The path is server-constructed
      // from a sanitized runId; single-quote it for the sh -c that pipe-pane runs.
      if (outputLogPath) {
        try {
          fs.mkdirSync(path.dirname(outputLogPath), { recursive: true, mode: 0o700 });
          const safeLog = String(outputLogPath).replace(/'/g, "'\\''");
          runTmuxCommand('tmux', ['pipe-pane', '-t', name, '-o', `cat >> '${safeLog}'`], { stdio: 'pipe' });
        } catch { /* tee best-effort — capture falls back to capture-pane */ }
      }

      // Execute the script in the tmux session
      runTmuxCommand('tmux', ['send-keys', '-t', name, `bash '${scriptPath}'`, 'Enter'], {
        stdio: 'pipe',
      });

      return { sessionName: name, engine: 'tmux' };
    } catch (error) {
      // Cleanup script, sentinel artifacts, AND tmux session on failure
      try { fs.unlinkSync(scriptPath); } catch {}
      try { fs.unlinkSync(exitSentinelPath); } catch {}
      try { fs.unlinkSync(exitSentinelTmpPath); } catch {}
      cleanupTokenArtifact(runId);
      try { runTmuxCommand('tmux', ['kill-session', '-t', name], { stdio: 'pipe' }); } catch {}
      throw new Error(`Failed to spawn tmux session: ${error.message}`);
    }
  }

  function getOutput(runId, lines = 200) {
    // Cap lines to prevent DoS via large scrollback capture
    const cappedLines = Math.min(Math.max(1, lines), 2000);
    const name = sessionName(runId);
    try {
      const output = runTmuxCommand(
        'tmux',
        ['capture-pane', '-pt', name, '-S', `-${cappedLines}`],
        { stdio: 'pipe', encoding: 'utf-8', timeout: 5000 }
      );
      return output;
    } catch {
      return null; // session may not exist
    }
  }

  function sendInput(runId, text) {
    const name = sessionName(runId);
    // Validate input length to prevent abuse
    if (!text || text.length > 10000) return false;
    try {
      // tmux send-keys with literal flag (-l) prevents key name interpretation
      // We send the text literally, then press Enter separately
      runTmuxCommand('tmux', ['send-keys', '-t', name, '-l', text], {
        stdio: 'pipe',
        timeout: 5000,
      });
      runTmuxCommand('tmux', ['send-keys', '-t', name, 'Enter'], {
        stdio: 'pipe',
        timeout: 5000,
      });
      return true;
    } catch {
      return false;
    }
  }

  function kill(runId) {
    const {
      name,
      scriptPath,
      exitSentinelPath,
      exitSentinelTmpPath,
    } = artifactPaths(runId);
    let killed = false;
    try {
      runTmuxCommand('tmux', ['kill-session', '-t', name], { stdio: 'pipe' });
      killed = true;
    } catch {
      // The session may already be gone; local artifacts still need cleanup.
    }
    try { fs.unlinkSync(scriptPath); } catch {}
    try { fs.unlinkSync(exitSentinelPath); } catch {}
    try { fs.unlinkSync(exitSentinelTmpPath); } catch {}
    cleanupTokenArtifact(runId);
    return killed;
  }

  function isAlive(runId) {
    const name = sessionName(runId);
    try {
      runTmuxCommand('tmux', ['has-session', '-t', name], { stdio: 'pipe', timeout: 3000 });
      return true;
    } catch {
      return false;
    }
  }

  function detectExitCode(runId) {
    const { exitSentinelPath } = artifactPaths(runId);
    try {
      const sentinel = fs.readFileSync(exitSentinelPath, 'utf-8');
      if (/^\d+\n?$/.test(sentinel)) {
        const exitCode = Number.parseInt(sentinel, 10);
        if (exitCode >= 0 && exitCode <= 255) return exitCode;
      }
    } catch {
      // Missing/unreadable sentinel: fall back to the diagnostic marker.
    }

    const output = getOutput(runId, 500);
    if (!output) return null;
    const match = output.match(/___EXIT_CODE_(\d+)___/);
    if (match) return parseInt(match[1], 10);

    return null;
  }

  function listSessions() {
    try {
      const output = runTmuxCommand(
        'tmux',
        ['list-sessions', '-F', '#{session_name}|#{session_created}|#{session_activity}'],
        { stdio: 'pipe', encoding: 'utf-8', timeout: 5000 }
      );
      return output.trim().split('\n').filter(Boolean).map(line => {
        const [name, created, activity] = line.split('|');
        return {
          name,
          created: parseInt(created, 10) * 1000,
          lastActivity: parseInt(activity, 10) * 1000,
          isPalantir: name.startsWith('palantir-run-'),
        };
      });
    } catch {
      return [];
    }
  }

  function discoverGhostSessions() {
    return listSessions().filter(s => s.isPalantir);
  }

  return {
    type: 'tmux',
    spawnAgent,
    getOutput,
    sendInput,
    kill,
    isAlive,
    detectExitCode,
    listSessions,
    discoverGhostSessions,
  };
}

// ---------- SubprocessEngine (fallback) ----------

function createSubprocessEngine({ actorTokens = resolveActorTokenPolicy() } = {}) {
  const processes = new Map();
  const PROCESS_TTL_MS = 10 * 60 * 1000; // Cleanup dead processes after 10 min

  function spawnAgent(runId, { command, args, cwd, env, outputLogPath }) {
    const safeCwd = validateCwd(cwd);
    assertSpawnAllowed({ command, source: 'executionEngine:subprocess' });

    const workerEnv = buildWorkerProcessEnv(process.env, env, actorTokens);
    // Ensure common binary paths are available (e.g., homebrew, nvm, local bins)
    const extraPaths = ['/opt/homebrew/bin', '/opt/homebrew/sbin', '/usr/local/bin'];
    const spawnEnv = augmentProcessPath(workerEnv, extraPaths);

    const child = spawn(command, args, {
      cwd: safeCwd,
      env: spawnEnv,
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: false,
    });

    const outputBuffer = [];
    const MAX_BUFFER_LINES = 500;

    // G1: optional file-backed tee (§5k-2) — durable stdout/stderr so a goal
    // worker's final output survives past this in-memory buffer / a restart.
    let logStream = null;
    if (outputLogPath) {
      try { logStream = fs.createWriteStream(outputLogPath, { flags: 'a', mode: 0o600 }); } catch { logStream = null; }
      if (logStream) logStream.on('error', () => { logStream = null; });
    }
    const appendOutput = (data) => {
      const lines = data.toString().split('\n');
      outputBuffer.push(...lines);
      while (outputBuffer.length > MAX_BUFFER_LINES) outputBuffer.shift();
      if (logStream) { try { logStream.write(data); } catch { /* tee best-effort */ } }
    };
    child.stdout.on('data', appendOutput);
    child.stderr.on('data', appendOutput);

    const proc = { child, outputBuffer, logStream, exitCode: null, exitedAt: null, spawnError: null };
    processes.set(runId, proc);

    // CRITICAL: Handle spawn errors (e.g., command not found — ENOENT).
    // Without this handler, the error becomes an uncaught exception and crashes the server.
    child.on('error', (err) => {
      console.error(`[subprocess] Spawn error for run ${runId}: ${err.message}`);
      proc.spawnError = err;
      proc.exitCode = 1;
      proc.exitedAt = Date.now();
    });

    child.on('exit', (code) => {
      if (proc) {
        proc.exitCode = code;
        proc.exitedAt = Date.now();
      }
    });

    // G1: end the tee on 'close' (all stdio drained), NOT 'exit' — a late
    // stdout/stderr 'data' chunk after 'exit' would otherwise write-after-end.
    // 'close' fires after the child's streams have fully flushed.
    if (logStream) {
      child.on('close', () => { try { logStream.end(); } catch { /* ignore */ } });
    }

    // Periodic cleanup of dead processes
    scheduleCleanup();

    return { pid: child.pid, engine: 'subprocess' };
  }

  let cleanupTimer = null;
  function scheduleCleanup() {
    if (cleanupTimer) return;
    cleanupTimer = setTimeout(() => {
      cleanupTimer = null;
      const now = Date.now();
      for (const [runId, proc] of processes) {
        if (proc.exitedAt && (now - proc.exitedAt) > PROCESS_TTL_MS) {
          processes.delete(runId);
        }
      }
    }, PROCESS_TTL_MS);
    cleanupTimer.unref(); // Don't prevent Node.js from exiting
  }

  function getOutput(runId, lines = 200) {
    const proc = processes.get(runId);
    if (!proc) return null;
    return proc.outputBuffer.slice(-lines).join('\n');
  }

  function sendInput(runId, text) {
    const proc = processes.get(runId);
    if (!proc || !proc.child.stdin.writable) return false;
    proc.child.stdin.write(text + '\n');
    return true;
  }

  function kill(runId) {
    const proc = processes.get(runId);
    if (!proc) return false;
    try {
      proc.child.kill('SIGTERM');
      // Don't delete immediately — let the exit handler record the exit code
      // The cleanup timer will remove it later
      return true;
    } catch {
      return false;
    }
  }

  function isAlive(runId) {
    const proc = processes.get(runId);
    if (!proc) return false;
    if (proc.spawnError) return false;
    return proc.exitCode === null;
  }

  function detectExitCode(runId) {
    const proc = processes.get(runId);
    if (!proc) return null;
    if (proc.spawnError) return 1;
    return proc.exitCode;
  }

  function listSessions() {
    return Array.from(processes.entries()).map(([runId, proc]) => ({
      name: `subprocess-${runId}`,
      pid: proc.child.pid,
      alive: proc.exitCode === null,
      isPalantir: true,
    }));
  }

  function discoverGhostSessions() {
    return []; // subprocess engine can't discover external processes
  }

  return {
    type: 'subprocess',
    spawnAgent,
    getOutput,
    sendInput,
    kill,
    isAlive,
    detectExitCode,
    listSessions,
    discoverGhostSessions,
  };
}

// ---------- Factory ----------

function createExecutionEngine({ actorTokens = resolveActorTokenPolicy() } = {}) {
  const hasTmux = detectTmux();
  if (hasTmux) {
    console.log('[executionEngine] Using TmuxEngine');
    return createTmuxEngine({ actorTokens });
  }
  console.log('[executionEngine] tmux not available, using SubprocessEngine');
  return createSubprocessEngine({ actorTokens });
}

module.exports = {
  createExecutionEngine,
  createTmuxEngine,
  createSubprocessEngine,
  buildWorkerProcessEnv,
};
