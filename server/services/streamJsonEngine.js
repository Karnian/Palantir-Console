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
 * Auth: Uses the user's existing Claude Code credentials (OAuth or API key)
 * loaded from .claude-auth.json at server startup (see index.js).
 */

function createStreamJsonEngine({ runService, eventBus } = {}) {
  const processes = new Map(); // runId → ProcessRecord
  const PROCESS_TTL_MS = 10 * 60 * 1000;

  /**
   * Resolve Claude Code binary path.
   */
  function resolveClaudeBin() {
    if (process.env.CLAUDE_BIN) return process.env.CLAUDE_BIN;

    const claudeCodeBase = path.join(os.homedir(), 'Library', 'Application Support', 'Claude', 'claude-code');
    const candidates = [];

    try {
      const versions = fs.readdirSync(claudeCodeBase).sort().reverse();
      for (const ver of versions) {
        candidates.push(path.join(claudeCodeBase, ver, 'claude.app', 'Contents', 'MacOS', 'claude'));
      }
    } catch { /* not on macOS */ }

    candidates.push(
      path.join(os.homedir(), '.claude', 'bin', 'claude'),
      '/usr/local/bin/claude',
      '/opt/homebrew/bin/claude',
    );

    for (const p of candidates) {
      try { if (fs.existsSync(p)) return p; } catch { /* ignore */ }
    }

    console.warn('[engine] Claude binary not found in known paths, falling back to PATH lookup: "claude"');
    return 'claude';
  }

  /**
   * Build CLI arguments for stream-json mode.
   */
  function buildArgs(opts) {
    const args = [
      '--print',
      '--output-format', 'stream-json',
      '--verbose',
    ];

    // For manager (multi-turn): use stream-json input format
    // IMPORTANT: Do NOT use -p with --input-format stream-json — they conflict.
    // The initial prompt is sent via stdin after spawn.
    if (opts.isManager) {
      args.push('--input-format', 'stream-json');
    } else {
      // Worker (single-shot): use -p with prompt
      if (opts.prompt) {
        args.push('-p', opts.prompt);
      }
    }

    if (opts.systemPrompt) {
      args.push('--append-system-prompt', opts.systemPrompt);
    }

    if (opts.permissionMode) {
      args.push('--permission-mode', opts.permissionMode);
    }

    if (opts.allowedTools && opts.allowedTools.length > 0) {
      args.push('--allowedTools', opts.allowedTools.join(','));
    }

    if (opts.maxBudgetUsd) {
      args.push('--max-budget-usd', String(opts.maxBudgetUsd));
    }

    if (opts.model) {
      args.push('--model', opts.model);
    }

    if (opts.mcpConfig) {
      args.push('--mcp-config', opts.mcpConfig);
    }

    if (opts.addDir) {
      args.push('--add-dir', opts.addDir);
    }

    if (!opts.isManager) {
      args.push('--no-session-persistence');
      // Set high max-turns so workers can complete complex multi-step tasks
      // without being cut short by CLI default limits.
      const maxTurns = opts.maxTurns ?? 200;
      args.push('--max-turns', String(maxTurns));
    }

    return args;
  }

  /**
   * Spawn a Claude Code agent with stream-json protocol.
   */
  function spawnAgent(runId, { prompt, cwd, env, systemPrompt, permissionMode,
    allowedTools, maxBudgetUsd, model, mcpConfig, addDir, isManager, maxTurns, onVendorEvent }) {

    const claudeBin = resolveClaudeBin();
    const args = buildArgs({
      prompt, systemPrompt, permissionMode, allowedTools,
      maxBudgetUsd, model, mcpConfig, addDir, isManager, maxTurns,
    });

    const extraPaths = ['/opt/homebrew/bin', '/opt/homebrew/sbin', '/usr/local/bin'];
    const currentPath = process.env.PATH || '';
    const augmentedPath = [...extraPaths, currentPath].join(path.delimiter);

    const safeCwd = cwd || process.cwd();
    if (!fs.existsSync(safeCwd)) {
      throw new Error(`cwd does not exist: ${safeCwd}`);
    }

    // PR4: if the caller passes a filtered env (manager adapter path), use it
    // as the authoritative base instead of process.env. Worker/legacy callers
    // still get the merge behavior.
    const baseEnv = (isManager && env) ? env : { ...process.env, ...(env || {}) };
    const spawnEnv = { ...baseEnv, PATH: augmentedPath };

    console.log(`[engine] Spawning claude for ${runId} (manager=${!!isManager})`);

    const child = spawn(claudeBin, args, {
      cwd: safeCwd,
      env: spawnEnv,
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
      onVendorEvent: typeof onVendorEvent === 'function' ? onVendorEvent : null,
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
        proc.outputBuffer.push(line);
      }
    });

    // Capture stderr
    const stderrBuf = [];
    child.stderr.on('data', (data) => {
      stderrBuf.push(data.toString());
      while (stderrBuf.length > 100) stderrBuf.shift();
    });

    child.on('error', (err) => {
      console.error(`[engine] Spawn error for ${runId}: ${err.message}`);
      proc.spawnError = err;
      proc.exitCode = 1;
      proc.exitedAt = Date.now();
      proc.status = 'failed';
      if (runService) {
        runService.addRunEvent(runId, 'error', JSON.stringify({
          message: `Spawn error: ${err.message}`,
        }));
      }
    });

    child.on('exit', (code, signal) => {
      console.log(`[engine] Process ${runId} exited: code=${code} signal=${signal}`);
      proc.exitCode = code;
      proc.exitedAt = Date.now();
      if (proc.status === 'starting' || proc.status === 'running') {
        proc.status = code === 0 ? 'completed' : 'failed';
      }

      // Finalize DB status on exit.
      // - Worker (single-shot): only if no `result` event arrived (the result handler
      //   already updates the DB; skipping prevents duplicate transitions).
      // - Manager (multi-turn): `result` arrives every turn but the session keeps
      //   running, so we MUST finalize on exit regardless of `proc.result`. Otherwise
      //   the run row stays as 'running' forever and shows up as a stale dashboard entry.
      // In both cases, never overwrite a terminal status (cancelled/stopped/completed/failed)
      // — that would clobber an explicit user `stop`/`cancel` with `failed`.
      const shouldFinalize = runService && (proc.isManager || !proc.result);
      if (shouldFinalize) {
        const dbStatus = code === 0 ? 'completed' : 'failed';
        try {
          let currentStatus = null;
          try { currentStatus = runService.getRun(runId)?.status; } catch { /* ignore */ }
          const terminal = ['completed', 'failed', 'cancelled', 'stopped'];
          if (!terminal.includes(currentStatus)) {
            runService.updateRunStatus(runId, dbStatus, { force: true });
          }
          runService.addRunEvent(runId, 'exit', JSON.stringify({
            exit_code: code,
            signal,
            stderr: stderrBuf.join('').slice(-2000),
          }));
        } catch { /* ignore */ }
      }
    });

    // For manager mode: send initial prompt via stdin (stream-json format)
    // because --input-format stream-json + -p flag don't work together.
    if (isManager && prompt) {
      const initMsg = JSON.stringify({
        type: 'user',
        message: { role: 'user', content: prompt },
      });
      console.log(`[engine] Sending initial prompt via stdin for ${runId}`);
      child.stdin.write(initMsg + '\n');
    }

    return { pid: child.pid, engine: 'stream-json', isManager };
  }

  /**
   * Handle a parsed NDJSON event from Claude Code.
   */
  function handleEvent(runId, proc, event) {
    proc.events.push(event);
    while (proc.events.length > 5000) proc.events.shift();

    // PR1b: vendor event hook for adapters that want to emit normalized events.
    // The hook fires BEFORE the legacy event handling below so that the adapter
    // can correlate raw vendor data with the legacy run_events writes that follow.
    if (proc.onVendorEvent) {
      try { proc.onVendorEvent(event, proc); } catch (err) {
        console.warn(`[engine] onVendorEvent hook threw for ${runId}: ${err.message}`);
      }
    }

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
              tools: (event.tools || []).slice(0, 20),
              cwd: event.cwd,
            }));
          }
          if (eventBus) eventBus.emit('run:init', { runId, sessionId: event.session_id });
        }
        break;
      }

      case 'assistant': {
        const msg = event.message;
        if (msg && msg.content) {
          const textParts = msg.content.filter(c => c.type === 'text').map(c => c.text);
          const text = textParts.join('\n');
          const toolUses = msg.content.filter(c => c.type === 'tool_use').map(c => ({ name: c.name, id: c.id }));

          if (text) {
            proc.outputBuffer.push(text);
            while (proc.outputBuffer.length > 500) proc.outputBuffer.shift();
            if (runService) {
              runService.addRunEvent(runId, 'assistant_text', JSON.stringify({ text: text.slice(0, 5000) }));
            }
          }

          if (toolUses.length > 0 && runService) {
            for (const tu of toolUses) {
              runService.addRunEvent(runId, 'tool_use', JSON.stringify({ tool: tu.name, id: tu.id }));
            }
          }

          if (msg.usage) {
            proc.usage.inputTokens += msg.usage.input_tokens || 0;
            proc.usage.outputTokens += msg.usage.output_tokens || 0;
          }
        }
        if (eventBus) eventBus.emit('run:output', { runId, event });
        break;
      }

      case 'result': {
        proc.result = event;

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

          try {
            runService.updateRunResult(runId, {
              result_summary: typeof event.result === 'string' ? event.result.slice(0, 2000) : null,
              exit_code: event.is_error ? 1 : 0,
              input_tokens: proc.usage.inputTokens,
              output_tokens: proc.usage.outputTokens,
              cost_usd: proc.usage.costUsd,
            });

            // For manager sessions: result event = one turn finished, NOT session end.
            // Only mark completed for non-manager (worker) runs.
            if (!proc.isManager) {
              // Check stop_reason to distinguish genuine completion from premature termination.
              // If the agent hit max_turns or was interrupted, treat as incomplete (needs_input)
              // so the user can review and optionally resume.
              const stopReason = event.stop_reason;
              const hitLimit = stopReason === 'max_turns' || stopReason === 'max_tokens';

              if (event.is_error) {
                proc.status = 'failed';
                runService.updateRunStatus(runId, 'failed', { force: true });
              } else if (hitLimit) {
                // Agent was cut short by turn/token limit — not a real completion
                proc.status = 'needs_input';
                runService.updateRunStatus(runId, 'needs_input', { force: true, reason: stopReason });
                runService.addRunEvent(runId, 'limit_reached', JSON.stringify({
                  message: `Agent stopped due to ${stopReason} — task may be incomplete`,
                  stop_reason: stopReason,
                  num_turns: event.num_turns,
                }));
                if (eventBus) {
                  eventBus.emit('run:needs_input', {
                    runId,
                    run: runService.getRun(runId),
                    from_status: 'running',
                    to_status: 'needs_input',
                    reason: stopReason,
                    priority: 'alert',
                  });
                }
              } else {
                proc.status = 'completed';
                runService.updateRunStatus(runId, 'completed', { force: true });
              }
            } else if (event.is_error) {
              // Manager: only transition to failed on error
              proc.status = 'failed';
              runService.updateRunStatus(runId, 'failed', { force: true });
            }
            // Manager non-error: stays 'running', ready for next turn
          } catch { /* ignore */ }
        }
        if (eventBus) eventBus.emit('run:result', { runId, result: event });
        break;
      }

      case 'rate_limit_event': break;
      default: break;
    }
  }

  /**
   * Send a user message via stdin (stream-json format for manager, raw text for worker).
   * @param {string} runId
   * @param {string} text
   * @param {Array<{data: string, media_type: string}>} [images] - base64 images (manager only)
   */
  function sendInput(runId, text, images) {
    const proc = processes.get(runId);
    if (!proc || !proc.child || !proc.child.stdin.writable) return false;
    if ((!text || text.length > 50000) && (!images || images.length === 0)) return false;

    let message;
    if (proc.isManager) {
      // Build content: if images present, use content blocks array
      let content;
      if (images && images.length > 0) {
        content = [];
        for (const img of images) {
          content.push({
            type: 'image',
            source: { type: 'base64', media_type: img.media_type, data: img.data },
          });
        }
        if (text) content.push({ type: 'text', text });
      } else {
        content = text;
      }
      message = JSON.stringify({ type: 'user', message: { role: 'user', content } });
    } else {
      message = text;
    }

    try {
      proc.child.stdin.write(message + '\n');
      if (runService) {
        runService.addRunEvent(runId, 'user_input', JSON.stringify({ text: text.slice(0, 5000) }));
      }
      return true;
    } catch (err) {
      console.warn(`[engine] stdin write failed for ${runId}: ${err.message}`);
      return false;
    }
  }

  function getOutput(runId, lines = 200) {
    const proc = processes.get(runId);
    if (!proc) return null;
    return proc.outputBuffer.slice(-lines).join('\n');
  }

  function getEvents(runId, afterIndex = 0) {
    const proc = processes.get(runId);
    if (!proc) return [];
    return proc.events.slice(afterIndex);
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
    try { proc.child.kill('SIGTERM'); return true; } catch { return false; }
  }

  function hasProcess(runId) {
    return processes.has(runId);
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

  function discoverGhostSessions() { return []; }

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
    type: 'stream-json',
    spawnAgent, sendInput, getOutput, getEvents, getUsage, getSessionId,
    kill, hasProcess, isAlive, detectExitCode, listSessions, discoverGhostSessions,
  };
}

module.exports = { createStreamJsonEngine };
