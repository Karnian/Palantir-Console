const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const readline = require('node:readline');

/**
 * StreamJsonEngine — Claude Code stream-json protocol engine.
 *
 * Uses `--print --input-format stream-json --output-format stream-json --verbose`
 * for structured NDJSON stdin/stdout communication with Claude Code CLI.
 *
 * Unlike TmuxEngine/SubprocessEngine which treat agent output as opaque text,
 * StreamJsonEngine parses structured events (init, assistant, result, tool_use, etc.)
 * and stores them as typed run_events in the database.
 */

// Default Claude Code binary path — resolved dynamically
const DEFAULT_CLAUDE_BIN = null; // resolved at runtime via resolveClaudeBin()

function createStreamJsonEngine({ runService, eventBus } = {}) {
  const processes = new Map(); // runId → ProcessRecord
  const PROCESS_TTL_MS = 10 * 60 * 1000;

  /**
   * @typedef {Object} ProcessRecord
   * @property {import('child_process').ChildProcess} child
   * @property {string[]} outputBuffer - raw NDJSON lines for debugging
   * @property {Object[]} events - parsed events
   * @property {number|null} exitCode
   * @property {number|null} exitedAt
   * @property {Error|null} spawnError
   * @property {string|null} sessionId - Claude Code session_id from init event
   * @property {Object|null} result - final result event
   * @property {Object} usage - accumulated usage/cost
   * @property {string} status - internal status tracking
   */

  /**
   * Resolve Claude Code binary path.
   */
  function resolveClaudeBin() {
    // Check environment variable first
    if (process.env.CLAUDE_BIN) return process.env.CLAUDE_BIN;

    // Discover installed Claude Code versions dynamically
    const claudeCodeBase = path.join(os.homedir(), 'Library', 'Application Support', 'Claude', 'claude-code');
    const candidates = [];

    // Scan for installed versions (e.g., 2.1.87/claude.app/Contents/MacOS/claude)
    try {
      const versions = fs.readdirSync(claudeCodeBase).sort().reverse(); // newest first
      for (const ver of versions) {
        candidates.push(path.join(claudeCodeBase, ver, 'claude.app', 'Contents', 'MacOS', 'claude'));
      }
    } catch { /* not on macOS or no Claude Code installed */ }

    // Other common paths
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

    // Fall back to PATH
    return 'claude';
  }

  /**
   * Build CLI arguments for a Claude Code stream-json session.
   *
   * @param {Object} opts
   * @param {string} opts.prompt - Initial prompt
   * @param {string} [opts.systemPrompt] - System prompt injection
   * @param {string} [opts.permissionMode] - Permission mode (default: 'bypassPermissions')
   * @param {string[]} [opts.allowedTools] - Allowed tool names
   * @param {number} [opts.maxBudgetUsd] - Max budget in USD
   * @param {string} [opts.model] - Model override
   * @param {string} [opts.mcpConfig] - Path to MCP config file
   * @param {string} [opts.addDir] - Additional directory for context
   * @param {boolean} [opts.isManager] - Whether this is a manager session
   */
  function buildArgs(opts) {
    const args = [
      '--print',
      '--input-format', 'stream-json',
      '--output-format', 'stream-json',
      '--verbose',
    ];

    // Initial prompt
    if (opts.prompt) {
      args.push('-p', opts.prompt);
    }

    // System prompt
    if (opts.systemPrompt) {
      args.push('--append-system-prompt', opts.systemPrompt);
    }

    // Permission mode
    const permMode = opts.permissionMode || 'bypassPermissions';
    args.push('--permission-mode', permMode);

    // Allowed tools
    if (opts.allowedTools && opts.allowedTools.length > 0) {
      args.push('--allowedTools', opts.allowedTools.join(','));
    }

    // Max budget
    if (opts.maxBudgetUsd) {
      args.push('--max-budget-usd', String(opts.maxBudgetUsd));
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

    // No session persistence for worker runs (they're ephemeral)
    if (!opts.isManager) {
      args.push('--no-session-persistence');
    }

    return args;
  }

  /**
   * Spawn a Claude Code agent with stream-json protocol.
   */
  function spawnAgent(runId, { prompt, cwd, env, systemPrompt, permissionMode,
    allowedTools, maxBudgetUsd, model, mcpConfig, addDir, isManager }) {

    const claudeBin = resolveClaudeBin();
    const args = buildArgs({
      prompt, systemPrompt, permissionMode, allowedTools,
      maxBudgetUsd, model, mcpConfig, addDir, isManager,
    });

    // Ensure common binary paths are available
    const extraPaths = ['/opt/homebrew/bin', '/opt/homebrew/sbin', '/usr/local/bin'];
    const currentPath = process.env.PATH || '';
    const augmentedPath = [...extraPaths, currentPath].join(path.delimiter);

    const safeCwd = cwd || process.cwd();
    if (!fs.existsSync(safeCwd)) {
      throw new Error(`cwd does not exist: ${safeCwd}`);
    }

    const child = spawn(claudeBin, args, {
      cwd: safeCwd,
      env: { ...process.env, ...env, PATH: augmentedPath },
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: false,
    });

    const proc = {
      child,
      outputBuffer: [],
      events: [],
      exitCode: null,
      exitedAt: null,
      spawnError: null,
      sessionId: null,
      result: null,
      usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
      status: 'starting',
      isManager: !!isManager,
    };
    processes.set(runId, proc);

    // Parse NDJSON from stdout
    const rl = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
    rl.on('line', (line) => {
      if (!line.trim()) return;
      try {
        const event = JSON.parse(line);
        handleEvent(runId, proc, event);
      } catch {
        // Non-JSON line, store as raw output
        proc.outputBuffer.push(line);
      }
    });

    // Capture stderr for debugging
    const stderrBuf = [];
    child.stderr.on('data', (data) => {
      stderrBuf.push(data.toString());
      // Cap stderr buffer
      while (stderrBuf.length > 100) stderrBuf.shift();
    });

    child.on('error', (err) => {
      console.error(`[streamJson] Spawn error for run ${runId}: ${err.message}`);
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
      if (proc.status === 'starting' || proc.status === 'running') {
        proc.status = code === 0 ? 'completed' : 'failed';
      }

      // Update DB status if no result event was received (abnormal exit)
      if (!proc.result && runService) {
        const dbStatus = code === 0 ? 'completed' : 'failed';
        try {
          runService.updateRunStatus(runId, dbStatus, { force: true });
          runService.addRunEvent(runId, 'exit', JSON.stringify({
            exit_code: code,
            message: `Process exited with code ${code} (no result event received)`,
          }));
        } catch { /* run might be deleted or already updated */ }
      }
    });

    return { pid: child.pid, engine: 'stream-json', isManager };
  }

  /**
   * Handle a parsed NDJSON event from Claude Code.
   */
  function handleEvent(runId, proc, event) {
    proc.events.push(event);
    // Cap events buffer
    while (proc.events.length > 5000) proc.events.shift();

    const type = event.type;
    const subtype = event.subtype;

    switch (type) {
      case 'system': {
        if (subtype === 'init') {
          proc.sessionId = event.session_id;
          proc.status = 'running';
          if (runService) {
            runService.addRunEvent(runId, 'init', JSON.stringify({
              session_id: event.session_id,
              model: event.model,
              tools: event.tools,
              cwd: event.cwd,
            }));
          }
          if (eventBus) {
            eventBus.emit('run:init', { runId, sessionId: event.session_id });
          }
        }
        break;
      }

      case 'assistant': {
        const msg = event.message;
        if (msg && msg.content) {
          // Extract text content
          const textParts = msg.content
            .filter(c => c.type === 'text')
            .map(c => c.text);
          const text = textParts.join('\n');

          // Extract tool_use blocks
          const toolUses = msg.content
            .filter(c => c.type === 'tool_use')
            .map(c => ({ name: c.name, id: c.id, input: c.input }));

          if (text) {
            proc.outputBuffer.push(text);
            if (runService) {
              runService.addRunEvent(runId, 'assistant_text', JSON.stringify({
                text: text.slice(0, 5000), // cap for DB storage
              }));
            }
          }

          if (toolUses.length > 0) {
            if (runService) {
              for (const tu of toolUses) {
                runService.addRunEvent(runId, 'tool_use', JSON.stringify({
                  tool: tu.name,
                  id: tu.id,
                  // Don't store full input (can be huge) — just tool name + id
                }));
              }
            }
          }

          // Track usage from assistant messages
          if (msg.usage) {
            proc.usage.inputTokens += msg.usage.input_tokens || 0;
            proc.usage.outputTokens += msg.usage.output_tokens || 0;
          }
        }

        if (eventBus) {
          eventBus.emit('run:output', { runId, event });
        }
        break;
      }

      case 'result': {
        proc.result = event;
        proc.status = event.is_error ? 'failed' : 'completed';

        // Extract final usage
        if (event.usage) {
          proc.usage.inputTokens = event.usage.input_tokens || proc.usage.inputTokens;
          proc.usage.outputTokens = event.usage.output_tokens || proc.usage.outputTokens;
        }
        if (event.total_cost_usd != null) {
          proc.usage.costUsd = event.total_cost_usd;
        }

        if (runService) {
          runService.addRunEvent(runId, 'result', JSON.stringify({
            is_error: event.is_error,
            duration_ms: event.duration_ms,
            stop_reason: event.stop_reason,
            result: typeof event.result === 'string' ? event.result.slice(0, 5000) : null,
            total_cost_usd: event.total_cost_usd,
            num_turns: event.num_turns,
          }));

          // Update run with final metrics
          try {
            runService.updateRunResult(runId, {
              result_summary: typeof event.result === 'string' ? event.result.slice(0, 2000) : null,
              exit_code: event.is_error ? 1 : 0,
              input_tokens: proc.usage.inputTokens,
              output_tokens: proc.usage.outputTokens,
              cost_usd: proc.usage.costUsd,
            });
          } catch { /* run might be deleted */ }
        }

        if (eventBus) {
          eventBus.emit('run:result', { runId, result: event });
        }
        break;
      }

      case 'rate_limit_event': {
        // Track but don't store every rate limit event
        break;
      }

      default: {
        // Store unknown event types for debugging
        if (runService) {
          runService.addRunEvent(runId, `unknown:${type}`, JSON.stringify(event).slice(0, 2000));
        }
        break;
      }
    }
  }

  /**
   * Send a user message to a running stream-json agent via stdin.
   */
  function sendInput(runId, text) {
    const proc = processes.get(runId);
    if (!proc || !proc.child || !proc.child.stdin.writable) return false;
    if (!text || text.length > 50000) return false;

    const message = JSON.stringify({
      type: 'user',
      message: {
        role: 'user',
        content: text,
      },
    });

    try {
      proc.child.stdin.write(message + '\n');

      if (runService) {
        runService.addRunEvent(runId, 'user_input', JSON.stringify({ text: text.slice(0, 5000) }));
      }

      return true;
    } catch {
      return false;
    }
  }

  /**
   * Get formatted output from a stream-json agent.
   */
  function getOutput(runId, lines = 200) {
    const proc = processes.get(runId);
    if (!proc) return null;
    return proc.outputBuffer.slice(-lines).join('\n');
  }

  /**
   * Get parsed events from a stream-json agent.
   */
  function getEvents(runId, afterIndex = 0) {
    const proc = processes.get(runId);
    if (!proc) return [];
    return proc.events.slice(afterIndex);
  }

  /**
   * Get accumulated usage/cost for a run.
   */
  function getUsage(runId) {
    const proc = processes.get(runId);
    if (!proc) return null;
    return { ...proc.usage };
  }

  /**
   * Get Claude Code session ID.
   */
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
      name: `stream-json-${runId}`,
      pid: proc.child?.pid,
      alive: proc.exitCode === null && !proc.spawnError,
      sessionId: proc.sessionId,
      isManager: proc.isManager,
      isPalantir: true,
    }));
  }

  function discoverGhostSessions() {
    return []; // stream-json engine can't discover external processes
  }

  // Periodic cleanup of exited processes
  const cleanupTimer = setInterval(() => {
    const now = Date.now();
    for (const [id, proc] of processes) {
      if (proc.exitedAt && (now - proc.exitedAt) > PROCESS_TTL_MS) {
        processes.delete(id);
      }
    }
  }, 60000); // check every 60s
  cleanupTimer.unref();

  return {
    type: 'stream-json',
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
