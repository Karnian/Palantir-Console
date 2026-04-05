const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const readline = require('node:readline');

/**
 * StreamJsonEngine — Claude Code interactive pipe engine.
 *
 * Spawns Claude Code CLI in interactive mode (NO --print) so it uses
 * the user's existing OAuth authentication. Communicates via stdin/stdout pipes.
 *
 * For Manager sessions: interactive multi-turn via stdin pipe.
 * For Worker sessions: single-shot prompt piped to stdin.
 *
 * This avoids the --print mode's OAuth limitation while still providing
 * structured communication with Claude Code CLI.
 */

function createStreamJsonEngine({ runService, eventBus } = {}) {
  const processes = new Map(); // runId → ProcessRecord
  const PROCESS_TTL_MS = 10 * 60 * 1000;

  /**
   * Resolve Claude Code binary path.
   */
  function resolveClaudeBin() {
    if (process.env.CLAUDE_BIN) return process.env.CLAUDE_BIN;

    // Discover installed Claude Code versions dynamically
    const claudeCodeBase = path.join(os.homedir(), 'Library', 'Application Support', 'Claude', 'claude-code');
    const candidates = [];

    try {
      const versions = fs.readdirSync(claudeCodeBase).sort().reverse(); // newest first
      for (const ver of versions) {
        candidates.push(path.join(claudeCodeBase, ver, 'claude.app', 'Contents', 'MacOS', 'claude'));
      }
    } catch { /* not on macOS or no Claude Code installed */ }

    candidates.push(
      path.join(os.homedir(), '.claude', 'bin', 'claude'),
      '/usr/local/bin/claude',
      '/opt/homebrew/bin/claude',
    );

    for (const p of candidates) {
      try {
        if (fs.existsSync(p)) return p;
      } catch { /* ignore */ }
    }

    return 'claude';
  }

  /**
   * Build CLI arguments for interactive mode.
   * NO --print, NO --input-format, NO --output-format
   * → uses OAuth auth, interactive stdin/stdout.
   */
  function buildArgs(opts) {
    const args = [];

    // System prompt
    if (opts.systemPrompt) {
      args.push('--append-system-prompt', opts.systemPrompt);
    }

    // Permission mode
    if (opts.permissionMode) {
      args.push('--permission-mode', opts.permissionMode);
    }

    // Allowed tools
    if (opts.allowedTools && opts.allowedTools.length > 0) {
      args.push('--allowedTools', opts.allowedTools.join(','));
    }

    // Model
    if (opts.model) {
      args.push('--model', opts.model);
    }

    // MCP config
    if (opts.mcpConfig) {
      args.push('--mcp-config', opts.mcpConfig);
    }

    // Additional directory
    if (opts.addDir) {
      args.push('--add-dir', opts.addDir);
    }

    // No session persistence for worker runs
    if (!opts.isManager) {
      args.push('--no-session-persistence');
    }

    // Verbose for more output
    args.push('--verbose');

    return args;
  }

  /**
   * Spawn a Claude Code agent in interactive mode.
   */
  function spawnAgent(runId, { prompt, cwd, env, systemPrompt, permissionMode,
    allowedTools, maxBudgetUsd, model, mcpConfig, addDir, isManager }) {

    const claudeBin = resolveClaudeBin();
    const args = buildArgs({
      systemPrompt, permissionMode, allowedTools,
      model, mcpConfig, addDir, isManager,
    });

    const extraPaths = ['/opt/homebrew/bin', '/opt/homebrew/sbin', '/usr/local/bin'];
    const currentPath = process.env.PATH || '';
    const augmentedPath = [...extraPaths, currentPath].join(path.delimiter);

    const safeCwd = cwd || process.cwd();
    if (!fs.existsSync(safeCwd)) {
      throw new Error(`cwd does not exist: ${safeCwd}`);
    }

    const spawnEnv = { ...process.env, ...env, PATH: augmentedPath };

    const child = spawn(claudeBin, args, {
      cwd: safeCwd,
      env: spawnEnv,
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: false,
    });

    const proc = {
      child,
      outputBuffer: [],
      exitCode: null,
      exitedAt: null,
      spawnError: null,
      sessionId: null,
      result: null,
      usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
      status: 'starting',
      isManager: !!isManager,
      currentResponse: '', // accumulate current response chunks
    };
    processes.set(runId, proc);

    // Read stdout line by line
    const rl = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
    rl.on('line', (line) => {
      handleOutputLine(runId, proc, line);
    });

    // Capture stderr
    const stderrBuf = [];
    child.stderr.on('data', (data) => {
      const text = data.toString();
      stderrBuf.push(text);
      while (stderrBuf.length > 100) stderrBuf.shift();

      // Check for auth errors in stderr
      if (text.includes('authentication') || text.includes('401') || text.includes('OAuth')) {
        if (runService) {
          runService.addRunEvent(runId, 'error', JSON.stringify({
            message: text.trim().slice(0, 2000),
          }));
        }
      }
    });

    child.on('error', (err) => {
      console.error(`[engine] Spawn error for run ${runId}: ${err.message}`);
      proc.spawnError = err;
      proc.exitCode = 1;
      proc.exitedAt = Date.now();
      proc.status = 'failed';

      if (runService) {
        runService.addRunEvent(runId, 'error', JSON.stringify({
          message: `Spawn error: ${err.message}`,
          stderr: stderrBuf.join('').slice(-2000),
        }));
      }
    });

    child.on('exit', (code) => {
      proc.exitCode = code;
      proc.exitedAt = Date.now();

      // Flush any accumulated response
      if (proc.currentResponse.trim()) {
        const text = proc.currentResponse.trim();
        proc.outputBuffer.push(text);
        if (runService) {
          runService.addRunEvent(runId, 'assistant_text', JSON.stringify({
            text: text.slice(0, 5000),
          }));
        }
        proc.currentResponse = '';
      }

      if (proc.status === 'starting' || proc.status === 'running') {
        proc.status = code === 0 ? 'completed' : 'failed';
      }

      // Update DB status
      if (runService) {
        const dbStatus = code === 0 ? 'completed' : 'failed';
        try {
          runService.updateRunStatus(runId, dbStatus, { force: true });
          runService.addRunEvent(runId, 'exit', JSON.stringify({
            exit_code: code,
            stderr: stderrBuf.join('').slice(-2000),
          }));
        } catch { /* ignore */ }
      }

      if (eventBus) {
        eventBus.emit('run:result', { runId, exitCode: code });
      }
    });

    // Send initial prompt after spawn
    proc.status = 'running';
    if (prompt) {
      // Small delay to let CLI initialize, then send prompt
      setTimeout(() => {
        if (proc.exitCode === null && child.stdin.writable) {
          child.stdin.write(prompt + '\n');
          if (runService) {
            runService.addRunEvent(runId, 'user_input', JSON.stringify({ text: prompt.slice(0, 5000) }));
          }
        }
      }, 500);
    }

    return { pid: child.pid, engine: 'interactive-pipe', isManager };
  }

  /**
   * Handle a line of output from Claude Code interactive mode.
   * Interactive mode outputs raw text — no NDJSON.
   */
  function handleOutputLine(runId, proc, line) {
    // Accumulate output
    proc.currentResponse += line + '\n';

    // Store each line in output buffer (cap at 2000 lines)
    proc.outputBuffer.push(line);
    while (proc.outputBuffer.length > 2000) proc.outputBuffer.shift();

    // Debounce: flush accumulated response after 500ms of silence
    if (proc._flushTimer) clearTimeout(proc._flushTimer);
    proc._flushTimer = setTimeout(() => {
      const text = proc.currentResponse.trim();
      if (text && runService) {
        runService.addRunEvent(runId, 'assistant_text', JSON.stringify({
          text: text.slice(0, 5000),
        }));
      }
      proc.currentResponse = '';

      if (eventBus) {
        eventBus.emit('run:output', { runId, text });
      }
    }, 500);
  }

  /**
   * Send a user message to a running interactive agent via stdin.
   */
  function sendInput(runId, text) {
    const proc = processes.get(runId);
    if (!proc || !proc.child || !proc.child.stdin.writable) return false;
    if (!text || text.length > 50000) return false;

    try {
      // Interactive mode: just write the text followed by newline
      proc.child.stdin.write(text + '\n');

      if (runService) {
        runService.addRunEvent(runId, 'user_input', JSON.stringify({ text: text.slice(0, 5000) }));
      }

      return true;
    } catch (err) {
      console.warn(`[engine] Failed to write to stdin for ${runId}: ${err.message}`);
      return false;
    }
  }

  function getOutput(runId, lines = 200) {
    const proc = processes.get(runId);
    if (!proc) return null;
    return proc.outputBuffer.slice(-lines).join('\n');
  }

  function getEvents(runId, afterIndex = 0) {
    // In interactive mode, events come from run_events table only
    return [];
  }

  function getUsage(runId) {
    const proc = processes.get(runId);
    if (!proc) return null;
    return { ...proc.usage };
  }

  function getSessionId(runId) {
    const proc = processes.get(runId);
    return proc?.sessionId || null;
  }

  function kill(runId) {
    const proc = processes.get(runId);
    if (!proc) return false;
    try {
      proc.child.kill('SIGTERM');
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
      name: `claude-${runId}`,
      pid: proc.child?.pid,
      alive: proc.exitCode === null && !proc.spawnError,
      sessionId: proc.sessionId,
      isManager: proc.isManager,
      isPalantir: true,
    }));
  }

  function discoverGhostSessions() {
    return [];
  }

  // Periodic cleanup
  const cleanupTimer = setInterval(() => {
    const now = Date.now();
    for (const [id, proc] of processes) {
      if (proc.exitedAt && (now - proc.exitedAt) > PROCESS_TTL_MS) {
        processes.delete(id);
      }
    }
  }, 60000);
  cleanupTimer.unref();

  return {
    type: 'stream-json', // keep type for compatibility
    spawnAgent,
    sendInput,
    getOutput,
    getEvents,
    getUsage,
    getSessionId,
    kill,
    isAlive,
    detectExitCode,
    listSessions,
    discoverGhostSessions,
  };
}

module.exports = { createStreamJsonEngine };
