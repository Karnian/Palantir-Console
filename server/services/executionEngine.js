const { execFileSync, execSync, spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { assertSpawnAllowed } = require('../utils/spawnGuard');
const {
  resolveActorTokenPolicy,
  buildWorkerProcessEnv,
  augmentProcessPath,
  applyWorkerCredentialPolicy,
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
 * Wrap a value in POSIX single quotes so a shell parses it as one literal
 * argument. Nest the call to quote a value that will be evaluated twice
 * (a `trap` body, `sh -c`), matching remoteSshExecutor's `shq`.
 */
function shq(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
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

/**
 * Remove one-shot secrets that survived an ungraceful Console exit before
 * the tmux bootstrap script could unlink them. This is intentionally called
 * once from the real server entry point, not from createTmuxEngine(), so
 * isolated app/test instances cannot sweep artifacts owned by one another.
 */
function cleanupStaleTmuxStartupArtifacts({
  tmpDir = os.tmpdir(),
  readdirSync = fs.readdirSync,
  unlinkSync = fs.unlinkSync,
  rmSync = fs.rmSync,
} = {}) {
  const scriptDir = path.join(tmpDir, 'palantir-scripts');
  let entries;
  try {
    entries = readdirSync(scriptDir, { withFileTypes: true });
  } catch {
    return { prompts: 0, capabilities: 0 };
  }

  // Prompt files are run-owned. They cannot be classified safely until the
  // lifecycle service has loaded the corresponding DB row and inspected the
  // tmux session, so this pre-DB sweep deliberately leaves them alone.
  const prompts = 0;
  let capabilities = 0;
  for (const entry of entries) {
    const name = typeof entry === 'string' ? entry : entry.name;
    if (/^\.worker-token-[a-zA-Z0-9_-]+$/.test(name)) {
      try {
        rmSync(path.join(scriptDir, name), { recursive: true, force: true });
        capabilities += 1;
      } catch {}
    }
  }
  return { prompts, capabilities };
}

// ---------- TmuxEngine ----------

function createTmuxEngine({
  execFileSync: runTmuxCommand = execFileSync,
  actorTokens = resolveActorTokenPolicy(),
  writeFileSync = fs.writeFileSync,
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
      stdinPath: path.join(scriptDir, `${name}.stdin`),
      exitSentinelPath: path.join(scriptDir, `${name}.exit`),
      exitSentinelTmpPath: path.join(scriptDir, `${name}.exit.tmp`),
      startedPath: path.join(scriptDir, `${name}.started`),
    };
  }

  function cleanupTokenArtifact(runId) {
    const artifact = tokenArtifacts.get(runId);
    if (!artifact) return;
    try { fs.unlinkSync(artifact.tokenPath); } catch {}
    if (artifact.apiBasePath) {
      try { fs.unlinkSync(artifact.apiBasePath); } catch {}
    }
    try { fs.rmdirSync(artifact.tokenDir); } catch {}
    tokenArtifacts.delete(runId);
  }

  function spawnAgent(
    runId,
    { command, args, stdin, cwd, env, outputLogPath },
    spawnActorTokens = actorTokens,
  ) {
    const {
      name,
      scriptDir,
      scriptPath,
      stdinPath,
      exitSentinelPath,
      exitSentinelTmpPath,
      startedPath,
    } = artifactPaths(runId);
    const safeCwd = validateCwd(cwd);
    assertSpawnAllowed({ command, source: 'executionEngine:tmux' });
    if (stdin !== undefined && typeof stdin !== 'string') {
      throw new Error('worker stdin must be a string when provided');
    }

    // SECURITY: Write the agent command to a temp script file instead of
    // interpolating into a shell string. This eliminates all injection vectors.
    fs.mkdirSync(scriptDir, { recursive: true, mode: 0o700 });
    // A previous server/process crash may have left a result for this sanitized
    // session name. Never let a new worker inherit that stale exit code.
    try { fs.unlinkSync(exitSentinelPath); } catch {}
    try { fs.unlinkSync(exitSentinelTmpPath); } catch {}
    try { fs.unlinkSync(stdinPath); } catch {}
    try { fs.unlinkSync(startedPath); } catch {}

    const profileEnv = buildWorkerProcessEnv(
      process.env,
      env && typeof env === 'object' ? env : {},
      spawnActorTokens,
    );
    const workerEnv = applyWorkerCredentialPolicy(profileEnv, {
      workerToken: profileEnv.PALANTIR_WORKER_TOKEN,
      apiBase: profileEnv.PALANTIR_API_BASE,
      actorTokens: spawnActorTokens,
    });
    // PATH_PREFIX is required on macOS installations where the Console starts
    // with a restricted PATH but worker CLIs live under Homebrew. workerEnv
    // contains process.env.PATH, so exporting it unchanged below would silently
    // undo that prefix. Preserve the caller's PATH while keeping the required
    // lookup directories at the front.
    const augmentedProfileEnv = augmentProcessPath(
      workerEnv,
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
    // The endpoint that pairs with the capability rides the same transport. It
    // is not itself a credential, but `env -i` puts every assignment into the
    // env process's own argv, which /proc exposes to other users on this host
    // for the window before it execs — the same exposure the remote path was
    // fixed for. Only meaningful alongside a minted token, so it is dropped
    // outright when there is none.
    const workerApiBase = workerToken
      && typeof augmentedProfileEnv.PALANTIR_API_BASE === 'string'
      && augmentedProfileEnv.PALANTIR_API_BASE
      ? augmentedProfileEnv.PALANTIR_API_BASE
      : null;
    delete augmentedProfileEnv.PALANTIR_API_BASE;
    cleanupTokenArtifact(runId);
    let tokenArtifact = null;
    if (workerToken) {
      let tokenDir = null;
      let tokenPath = null;
      let apiBasePath = null;
      try {
        tokenDir = fs.mkdtempSync(path.join(scriptDir, '.worker-token-'));
        fs.chmodSync(tokenDir, 0o700);
        tokenPath = path.join(tokenDir, 'token');
        writeFileSync(tokenPath, workerToken, { flag: 'wx', mode: 0o600 });
        if (workerApiBase) {
          apiBasePath = path.join(tokenDir, 'api-base');
          writeFileSync(apiBasePath, workerApiBase, { flag: 'wx', mode: 0o600 });
        }
      } catch (error) {
        if (apiBasePath) {
          try { fs.unlinkSync(apiBasePath); } catch {}
        }
        if (tokenPath) {
          try { fs.unlinkSync(tokenPath); } catch {}
        }
        if (tokenDir) {
          try { fs.rmdirSync(tokenDir); } catch {}
        }
        throw error;
      }
      tokenArtifact = { tokenDir, tokenPath, apiBasePath };
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
      `: > ${shq(startedPath)}`,
      // A long-lived tmux server can retain credentials from an older Console
      // configuration. Clear actor tokens as defense-in-depth; the agent
      // command itself is launched with env -i below so no other inherited
      // server credential can cross the profile allowlist boundary either.
      'unset PALANTIR_TOKEN PALANTIR_PM_TOKEN PALANTIR_WORKER_TOKEN PALANTIR_MANAGER_TOKEN',
    ];
    let workerCapabilityBootstrap = null;
    if (tokenArtifact) {
      // Restore run-bound values only after env -i has started a clean shell.
      // Expanding KEY="$value" as an env argument would put the value in the
      // real /usr/bin/env argv before the child replaces it.
      workerCapabilityBootstrap = [
        `PALANTIR_WORKER_TOKEN=$(cat -- ${shq(tokenArtifact.tokenPath)})`,
        'worker_token_rc=$?',
        `rm -f -- ${shq(tokenArtifact.tokenPath)}`,
      ];
      if (tokenArtifact.apiBasePath) {
        workerCapabilityBootstrap.push(
          `PALANTIR_API_BASE=$(cat -- ${shq(tokenArtifact.apiBasePath)})`,
          'worker_api_base_rc=$?',
          `rm -f -- ${shq(tokenArtifact.apiBasePath)}`,
        );
      }
      workerCapabilityBootstrap.push(
        `rmdir -- ${shq(tokenArtifact.tokenDir)} 2>/dev/null || true`,
        '[ "$worker_token_rc" -eq 0 ] || exit 78',
      );
      if (tokenArtifact.apiBasePath) {
        workerCapabilityBootstrap.push(
          '[ "$worker_api_base_rc" -eq 0 ] || exit 78',
        );
      }
      workerCapabilityBootstrap.push(
        'export PALANTIR_WORKER_TOKEN',
        ...(tokenArtifact.apiBasePath ? ['export PALANTIR_API_BASE'] : []),
        'exec "$@"',
      );
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
    const workerCapabilityArgs = workerCapabilityBootstrap
      ? ` /bin/sh -c ${shq(workerCapabilityBootstrap.join('; '))} ${shq('sh')}`
      : '';
    const quotedStdin = shq(stdinPath);
    const stdinRedirect = stdin !== undefined ? ` < ${quotedStdin}` : '';
    // The trap body is evaluated TWICE — once when the script itself is parsed,
    // and again when the shell runs the handler. A path quoted only once has
    // its escapes consumed by the first pass, so a `'` in TMPDIR would make the
    // handler a syntax error. Quote the fully-formed command a second time, the
    // same nesting the remote executor uses (shq of an already-shq'd path).
    const stdinCleanupCommand = `PATH="$${publishPathVar}" rm -f -- ${quotedStdin}`;
    if (stdin !== undefined) {
      // Ensure signals or an unexpected script error do not strand prompt
      // material on disk. The explicit normal-path cleanup below removes the
      // file first and only then clears this trap.
      lines.push(`trap ${shq(stdinCleanupCommand)} EXIT HUP INT TERM`);
    }
    lines.push(`env -i ${workerEnvArgs.join(' ')}${workerCapabilityArgs} '${safeCmd}' ${quotedArgs.join(' ')}${stdinRedirect}`);
    // Capture $? exactly once so the durable sentinel and scrollback marker
    // always describe the same agent exit. Rename makes the sentinel atomic.
    const safeSentinel = exitSentinelPath.replace(/'/g, "'\\''");
    const safeSentinelTmp = exitSentinelTmpPath.replace(/'/g, "'\\''");
    lines.push('agent_exit_code=$?');
    if (stdin !== undefined) {
      // Remove BEFORE disarming: clearing the trap first leaves a window where
      // a HUP/TERM arriving between the two lines has no handler left to run.
      lines.push(stdinCleanupCommand);
      lines.push('trap - EXIT HUP INT TERM');
    }
    lines.push(`printf '%s\\n' "$agent_exit_code" > '${safeSentinelTmp}'`);
    lines.push('echo "___EXIT_CODE_${agent_exit_code}___"');
    lines.push(`PATH="$${publishPathVar}" mv -f -- '${safeSentinelTmp}' '${safeSentinel}'`);
    lines.push(`PATH="$${publishPathVar}" rm -f -- ${shq(startedPath)}`);

    // Persist the prompt only after every other fallible preparation step has
    // completed. This keeps token-directory/configuration failures from
    // stranding sensitive prompt material before the worker script owns it.
    if (stdin !== undefined) {
      try {
        writeFileSync(stdinPath, stdin, { mode: 0o600, flag: 'wx' });
      } catch (error) {
        // writeFileSync can fail after creating a partial file (ENOSPC/EIO).
        // Never leave either the prompt fragment or a prepared capability.
        try { fs.unlinkSync(stdinPath); } catch {}
        cleanupTokenArtifact(runId);
        throw error;
      }
    }

    try {
      writeFileSync(scriptPath, lines.join('\n') + '\n', { mode: 0o700 });
    } catch (error) {
      try { fs.unlinkSync(stdinPath); } catch {}
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

      // Execute the script in the tmux session. send-keys types this into the
      // pane's interactive shell, so the path must be quoted — an unquoted
      // scriptPath silently fails to start the worker when TMPDIR contains a
      // quote or space, stranding the run and its prompt file.
      runTmuxCommand('tmux', ['send-keys', '-t', name, `bash ${shq(scriptPath)}`, 'Enter'], {
        stdio: 'pipe',
      });

      return { sessionName: name, engine: 'tmux' };
    } catch (error) {
      // Cleanup script, sentinel artifacts, AND tmux session on failure
      try { fs.unlinkSync(scriptPath); } catch {}
      try { fs.unlinkSync(stdinPath); } catch {}
      try { fs.unlinkSync(exitSentinelPath); } catch {}
      try { fs.unlinkSync(exitSentinelTmpPath); } catch {}
      try { fs.unlinkSync(startedPath); } catch {}
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
      stdinPath,
      exitSentinelPath,
      exitSentinelTmpPath,
      startedPath,
    } = artifactPaths(runId);
    let killed = false;
    try {
      runTmuxCommand('tmux', ['kill-session', '-t', name], { stdio: 'pipe' });
      killed = true;
    } catch {
      // The session may already be gone; local artifacts still need cleanup.
    }
    try { fs.unlinkSync(scriptPath); } catch {}
    try { fs.unlinkSync(stdinPath); } catch {}
    try { fs.unlinkSync(exitSentinelPath); } catch {}
    try { fs.unlinkSync(exitSentinelTmpPath); } catch {}
    try { fs.unlinkSync(startedPath); } catch {}
    cleanupTokenArtifact(runId);
    return killed;
  }

  /**
   * Classify a boot-time tmux artifact without changing it.
   *
   * The durable .started marker is written by the bootstrap script itself, not
   * by the controller. For pre-marker workers, fall back to the pane process
   * tree and require the exact generated script path. Any inspection failure is
   * "unknown", which callers must preserve.
   */
  function inspectStartupArtifacts(runId) {
    const paths = artifactPaths(runId);
    const artifactFiles = [
      paths.scriptPath,
      paths.stdinPath,
      paths.exitSentinelPath,
      paths.exitSentinelTmpPath,
      paths.startedPath,
    ];
    const existingArtifacts = artifactFiles.filter((filePath) => fs.existsSync(filePath));
    const sessionExists = isAlive(runId);
    if (!sessionExists) {
      return {
        state: 'no_session',
        sessionExists: false,
        existingArtifacts,
      };
    }
    if (fs.existsSync(paths.startedPath)) {
      return {
        state: 'running',
        sessionExists: true,
        existingArtifacts,
      };
    }

    let panePid;
    try {
      const value = runTmuxCommand(
        'tmux',
        ['display-message', '-p', '-t', paths.name, '#{pane_pid}'],
        { stdio: 'pipe', encoding: 'utf-8', timeout: 3000 },
      );
      panePid = Number.parseInt(String(value).trim(), 10);
      if (!Number.isInteger(panePid) || panePid <= 0) throw new Error('invalid pane pid');
    } catch {
      return {
        state: 'unknown',
        sessionExists: true,
        existingArtifacts,
      };
    }

    try {
      const output = runTmuxCommand(
        'ps',
        ['-axo', 'pid=,ppid=,command='],
        { stdio: 'pipe', encoding: 'utf-8', timeout: 3000 },
      );
      const processes = String(output).split('\n').map((line) => {
        const match = line.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/);
        return match
          ? { pid: Number(match[1]), ppid: Number(match[2]), command: match[3] }
          : null;
      }).filter(Boolean);
      const descendants = new Set([panePid]);
      let changed = true;
      while (changed) {
        changed = false;
        for (const proc of processes) {
          if (descendants.has(proc.ppid) && !descendants.has(proc.pid)) {
            descendants.add(proc.pid);
            changed = true;
          }
        }
      }
      const scriptIsRunning = processes.some(
        (proc) => descendants.has(proc.pid) && proc.pid !== panePid
          && proc.command.includes(paths.scriptPath),
      );
      return {
        state: scriptIsRunning ? 'running' : 'idle_shell',
        sessionExists: true,
        existingArtifacts,
      };
    } catch {
      return {
        state: 'unknown',
        sessionExists: true,
        existingArtifacts,
      };
    }
  }

  /**
   * Reap only artifacts whose inactivity was positively established. This is
   * intentionally fail-safe: a live worker or an uncertain inspection is never
   * killed and no file is removed.
   */
  function reapStartupArtifacts(runId) {
    let inspected = inspectStartupArtifacts(runId);
    if (inspected.state === 'running' || inspected.state === 'unknown') {
      return { action: 'preserved', reason: inspected.state, removed: [] };
    }
    if (inspected.existingArtifacts.length === 0) {
      return { action: 'none', reason: inspected.state, removed: [] };
    }

    if (inspected.state === 'idle_shell') {
      // Close the classify→kill race as far as a synchronous tmux API permits.
      // If the script starts between checks, its marker/process tree wins.
      inspected = inspectStartupArtifacts(runId);
      if (inspected.state !== 'idle_shell') {
        return { action: 'preserved', reason: inspected.state, removed: [] };
      }
      try {
        runTmuxCommand('tmux', ['kill-session', '-t', artifactPaths(runId).name], {
          stdio: 'pipe',
          timeout: 3000,
        });
      } catch {
        return { action: 'preserved', reason: 'kill_failed', removed: [] };
      }
    }

    const removed = [];
    for (const filePath of inspected.existingArtifacts) {
      try {
        fs.unlinkSync(filePath);
        removed.push(filePath);
      } catch {
        // A partial cleanup is still reported accurately for the run event.
      }
    }
    cleanupTokenArtifact(runId);
    return {
      action: removed.length > 0 ? 'removed' : 'none',
      reason: inspected.state,
      removed,
    };
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

  let api;
  function withActorTokenPolicy(nextActorTokens) {
    return {
      ...api,
      spawnAgent(runId, spec) {
        return spawnAgent(runId, spec, nextActorTokens);
      },
    };
  }

  api = {
    type: 'tmux',
    withActorTokenPolicy,
    spawnAgent,
    getOutput,
    sendInput,
    kill,
    isAlive,
    detectExitCode,
    listSessions,
    discoverGhostSessions,
    inspectStartupArtifacts,
    reapStartupArtifacts,
  };
  return api;
}

// ---------- SubprocessEngine (fallback) ----------

function createSubprocessEngine({
  actorTokens = resolveActorTokenPolicy(),
} = {}) {
  const processes = new Map();
  const PROCESS_TTL_MS = 10 * 60 * 1000; // Cleanup dead processes after 10 min

  function spawnAgent(
    runId,
    { command, args, stdin, cwd, env, outputLogPath },
    spawnActorTokens = actorTokens,
  ) {
    const safeCwd = validateCwd(cwd);
    assertSpawnAllowed({ command, source: 'executionEngine:subprocess' });
    if (stdin !== undefined && typeof stdin !== 'string') {
      throw new Error('worker stdin must be a string when provided');
    }

    const profileEnv = buildWorkerProcessEnv(process.env, env, spawnActorTokens);
    const workerEnv = applyWorkerCredentialPolicy(profileEnv, {
      workerToken: profileEnv.PALANTIR_WORKER_TOKEN,
      apiBase: profileEnv.PALANTIR_API_BASE,
      actorTokens: spawnActorTokens,
    });
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

    if (stdin !== undefined) {
      // A fast-failing child may close the pipe before end() completes. Handle
      // EPIPE locally so hostile/invalid prompt content can never become an
      // uncaught server error; the child's real exit code remains authoritative.
      child.stdin.on('error', () => {});
      child.stdin.end(stdin);
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

  let api;
  function withActorTokenPolicy(nextActorTokens) {
    return {
      ...api,
      spawnAgent(runId, spec) {
        return spawnAgent(runId, spec, nextActorTokens);
      },
    };
  }

  api = {
    type: 'subprocess',
    withActorTokenPolicy,
    spawnAgent,
    getOutput,
    sendInput,
    kill,
    isAlive,
    detectExitCode,
    listSessions,
    discoverGhostSessions,
  };
  return api;
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
  cleanupStaleTmuxStartupArtifacts,
  buildWorkerProcessEnv,
};
