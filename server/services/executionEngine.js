const { execFileSync, execSync, spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

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

function createTmuxEngine() {
  const PATH_PREFIX = 'export PATH="/opt/homebrew/bin:/opt/homebrew/sbin:$PATH"';

  function sessionName(runId) {
    return sanitizeSessionName(`palantir-run-${runId}`);
  }

  function spawnAgent(runId, { command, args, cwd, env }) {
    const name = sessionName(runId);
    const safeCwd = validateCwd(cwd);

    // SECURITY: Write the agent command to a temp script file instead of
    // interpolating into a shell string. This eliminates all injection vectors.
    const scriptDir = path.join(os.tmpdir(), 'palantir-scripts');
    fs.mkdirSync(scriptDir, { recursive: true });
    const scriptPath = path.join(scriptDir, `${name}.sh`);

    const lines = ['#!/bin/bash', PATH_PREFIX];

    // Set environment variables safely (no shell interpolation)
    if (env && typeof env === 'object') {
      for (const [k, v] of Object.entries(env)) {
        // Validate key is a valid env var name
        if (/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(k)) {
          // Use single quotes to prevent shell expansion in values
          const safeVal = String(v).replace(/'/g, "'\\''");
          lines.push(`export ${k}='${safeVal}'`);
        }
      }
    }

    // Build command with proper quoting
    const quotedArgs = args.map(a => {
      const safeArg = String(a).replace(/'/g, "'\\''");
      return `'${safeArg}'`;
    });
    const safeCmd = String(command).replace(/'/g, "'\\''");
    lines.push(`'${safeCmd}' ${quotedArgs.join(' ')}`);
    lines.push('echo "___EXIT_CODE_$?___"');

    fs.writeFileSync(scriptPath, lines.join('\n') + '\n', { mode: 0o700 });

    try {
      // Create tmux session — all args passed as array (no shell interpolation)
      execFileSync('tmux', ['new-session', '-d', '-s', name, '-c', safeCwd], {
        stdio: 'pipe',
      });

      // Execute the script in the tmux session
      execFileSync('tmux', ['send-keys', '-t', name, `bash '${scriptPath}'`, 'Enter'], {
        stdio: 'pipe',
      });

      return { sessionName: name, engine: 'tmux' };
    } catch (error) {
      // Cleanup script AND tmux session on failure
      try { fs.unlinkSync(scriptPath); } catch {}
      try { execFileSync('tmux', ['kill-session', '-t', name], { stdio: 'pipe' }); } catch {}
      throw new Error(`Failed to spawn tmux session: ${error.message}`);
    }
  }

  function getOutput(runId, lines = 200) {
    // Cap lines to prevent DoS via large scrollback capture
    const cappedLines = Math.min(Math.max(1, lines), 2000);
    const name = sessionName(runId);
    try {
      const output = execFileSync(
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
      execFileSync('tmux', ['send-keys', '-t', name, '-l', text], {
        stdio: 'pipe',
        timeout: 5000,
      });
      execFileSync('tmux', ['send-keys', '-t', name, 'Enter'], {
        stdio: 'pipe',
        timeout: 5000,
      });
      return true;
    } catch {
      return false;
    }
  }

  function kill(runId) {
    const name = sessionName(runId);
    try {
      execFileSync('tmux', ['kill-session', '-t', name], { stdio: 'pipe' });
      // Cleanup temp script
      const scriptPath = path.join(os.tmpdir(), 'palantir-scripts', `${name}.sh`);
      try { fs.unlinkSync(scriptPath); } catch {}
      return true;
    } catch {
      return false;
    }
  }

  function isAlive(runId) {
    const name = sessionName(runId);
    try {
      execFileSync('tmux', ['has-session', '-t', name], { stdio: 'pipe', timeout: 3000 });
      return true;
    } catch {
      return false;
    }
  }

  function detectExitCode(runId) {
    const output = getOutput(runId, 50);
    if (!output) return null;
    const match = output.match(/___EXIT_CODE_(\d+)___/);
    return match ? parseInt(match[1], 10) : null;
  }

  function listSessions() {
    try {
      const output = execFileSync(
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

function createSubprocessEngine() {
  const processes = new Map();
  const PROCESS_TTL_MS = 10 * 60 * 1000; // Cleanup dead processes after 10 min

  function spawnAgent(runId, { command, args, cwd, env }) {
    const safeCwd = validateCwd(cwd);

    // Ensure common binary paths are available (e.g., homebrew, nvm, local bins)
    const extraPaths = ['/opt/homebrew/bin', '/opt/homebrew/sbin', '/usr/local/bin'];
    const currentPath = process.env.PATH || '';
    const augmentedPath = [...extraPaths, currentPath].join(path.delimiter);

    const child = spawn(command, args, {
      cwd: safeCwd,
      env: { ...process.env, ...env, PATH: augmentedPath },
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: false,
    });

    const outputBuffer = [];
    const MAX_BUFFER_LINES = 500;

    child.stdout.on('data', (data) => {
      const lines = data.toString().split('\n');
      outputBuffer.push(...lines);
      while (outputBuffer.length > MAX_BUFFER_LINES) outputBuffer.shift();
    });

    child.stderr.on('data', (data) => {
      const lines = data.toString().split('\n');
      outputBuffer.push(...lines);
      while (outputBuffer.length > MAX_BUFFER_LINES) outputBuffer.shift();
    });

    const proc = { child, outputBuffer, exitCode: null, exitedAt: null, spawnError: null };
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

function createExecutionEngine() {
  const hasTmux = detectTmux();
  if (hasTmux) {
    console.log('[executionEngine] Using TmuxEngine');
    return createTmuxEngine();
  }
  console.log('[executionEngine] tmux not available, using SubprocessEngine');
  return createSubprocessEngine();
}

module.exports = { createExecutionEngine, createTmuxEngine, createSubprocessEngine };
