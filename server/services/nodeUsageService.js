const { formatLimits } = require('./codexService');
const { fetchClaudeCodeUsage } = require('./providers/claude-code');

const DEFAULT_PROBE_TIMEOUT_MS = 15000;
const DEFAULT_PROBE_KILL_GRACE_MS = 2000;
const DEFAULT_OUTPUT_MAX_BYTES = 256 * 1024;

const ERROR_CODES = new Set([
  'not_installed',
  'probe_failed',
  'timeout',
  'transport_lost',
  'no_data',
  'not_logged_in',
  'quota_unsupported',
]);

const COMMANDS = Object.freeze({
  codexVersion: Object.freeze({ command: 'codex', args: Object.freeze(['--version']) }),
  codexAppServer: Object.freeze({ command: 'codex', args: Object.freeze(['app-server']) }),
  claudeVersion: Object.freeze({ command: 'claude', args: Object.freeze(['--version']) }),
  claudeAuthStatus: Object.freeze({ command: 'claude', args: Object.freeze(['auth', 'status']) }),
});

class UsageProbeError extends Error {
  constructor(code, message) {
    super(sanitizeMessage(message || code));
    this.usageCode = ERROR_CODES.has(code) ? code : 'probe_failed';
  }
}

function sanitizeMessage(value) {
  const text = String(value || '')
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, 'Bearer [redacted]')
    .replace(/sk-[A-Za-z0-9_-]+/g, '[redacted]')
    .replace(/[A-Za-z0-9._%+-]+:[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+/g, '[redacted]@')
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > 180 ? `${text.slice(0, 177)}...` : text;
}

function nowIso() {
  return new Date().toISOString();
}

function nodeEnvelope(node) {
  return {
    id: node.id,
    name: node.name,
    kind: node.kind,
    reachable: node.reachable,
  };
}

function card(id, fields = {}) {
  return {
    id,
    installed: fields.installed ?? null,
    version: fields.version ?? null,
    usage: fields.usage ?? null,
    authStatus: fields.authStatus ?? null,
    error: fields.error ?? null,
    updatedAt: fields.updatedAt || nowIso(),
  };
}

function errorObject(code, message) {
  return {
    code: ERROR_CODES.has(code) ? code : 'probe_failed',
    message: sanitizeMessage(message || code),
  };
}

function errorCard(id, code, message, fields = {}) {
  return card(id, {
    installed: fields.installed ?? null,
    version: fields.version ?? null,
    usage: null,
    authStatus: fields.authStatus ?? null,
    error: errorObject(code, message),
    updatedAt: fields.updatedAt,
  });
}

function normalizeUsageError(err, fallbackCode = 'probe_failed', fallbackMessage = 'probe failed') {
  if (err instanceof UsageProbeError) return errorObject(err.usageCode, err.message);
  if (err?.usageCode && ERROR_CODES.has(err.usageCode)) return errorObject(err.usageCode, err.message);
  if (err?.code === 'SSH_TRANSPORT' || err?.exitCode === 255) {
    return errorObject('transport_lost', 'ssh transport lost');
  }
  return errorObject(fallbackCode, fallbackMessage);
}

function maybeEndStdin(child) {
  try {
    if (child?.stdin && !child.stdin.destroyed && typeof child.stdin.end === 'function') {
      child.stdin.end();
    }
  } catch {
    // Best effort cleanup.
  }
}

function killChild(child, signal) {
  try {
    if (child && typeof child.kill === 'function') child.kill(signal);
  } catch {
    // Best effort cleanup.
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForCloseOrDelay(closePromise, ms) {
  if (ms <= 0) return null;
  return Promise.race([closePromise, delay(ms).then(() => null)]);
}

function chunkToString(chunk) {
  return Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
}

async function withProbeChild(spawnInteractive, commandSpec, {
  pathPrefix,
  timeoutMs,
  killGraceMs,
  maxOutputBytes,
}, interact) {
  const { command, args } = commandSpec;
  let child = null;
  let closeInfo = null;
  let closePromise = null;
  let timeout = null;
  let failed = false;
  let rejectFailure = null;
  const stdoutListeners = new Set();
  const stderrListeners = new Set();
  const output = { stdout: '', stderr: '' };
  const outputBytes = { stdout: 0, stderr: 0 };
  const failurePromise = new Promise((_, reject) => {
    rejectFailure = reject;
  });

  function fail(err) {
    if (failed) return;
    failed = true;
    rejectFailure(err instanceof UsageProbeError ? err : new UsageProbeError('probe_failed', err?.message || 'probe failed'));
    killChild(child, 'SIGTERM');
  }

  function addOutput(kind, chunk) {
    const text = chunkToString(chunk);
    outputBytes[kind] += Buffer.byteLength(text);
    // Cap is combined stdout+stderr — the contract bounds total transfer per
    // probe, not per stream (Codex R2 finding 1).
    if (outputBytes.stdout + outputBytes.stderr > maxOutputBytes) {
      fail(new UsageProbeError('probe_failed', `${command} probe output exceeded limit`));
      return;
    }
    output[kind] += text;
    const listeners = kind === 'stdout' ? stdoutListeners : stderrListeners;
    for (const listener of listeners) listener(text);
  }

  try {
    child = await spawnInteractive(command, Array.from(args), {
      env: {},
      pathPrefix: pathPrefix || undefined,
    });

    closePromise = new Promise((resolve) => {
      child.once('close', (code, signal) => {
        closeInfo = { code, signal };
        resolve(closeInfo);
      });
    });

    if (child.stdout?.on) child.stdout.on('data', (chunk) => addOutput('stdout', chunk));
    if (child.stderr?.on) child.stderr.on('data', (chunk) => addOutput('stderr', chunk));
    if (child.once) {
      child.once('error', (err) => fail(new UsageProbeError('probe_failed', err?.message || `${command} probe failed`)));
    }

    timeout = setTimeout(() => {
      fail(new UsageProbeError('timeout', `${command} probe timed out`));
    }, timeoutMs);
    if (typeof timeout.unref === 'function') timeout.unref();

    return await Promise.race([
      interact({
        child,
        output,
        closePromise,
        onStdout(listener) { stdoutListeners.add(listener); return () => stdoutListeners.delete(listener); },
        onStderr(listener) { stderrListeners.add(listener); return () => stderrListeners.delete(listener); },
      }),
      failurePromise,
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
    stdoutListeners.clear();
    stderrListeners.clear();
    if (child && !closeInfo) {
      maybeEndStdin(child);
      killChild(child, 'SIGTERM');
      await waitForCloseOrDelay(closePromise || Promise.resolve(null), killGraceMs);
      if (!closeInfo) {
        killChild(child, 'SIGKILL');
        await waitForCloseOrDelay(closePromise || Promise.resolve(null), 50);
      }
    }
  }
}

async function runCommandProbe(spawnInteractive, commandSpec, opts) {
  const result = await withProbeChild(spawnInteractive, commandSpec, opts, async ({ child, output, closePromise }) => {
    maybeEndStdin(child);
    const closeInfo = await closePromise;
    if (closeInfo?.code === 255) {
      throw new UsageProbeError('transport_lost', 'ssh transport lost');
    }
    return {
      code: closeInfo?.code ?? null,
      signal: closeInfo?.signal ?? null,
      stdout: output.stdout,
      stderr: output.stderr,
    };
  });
  return result;
}

async function probeVersion(spawnInteractive, commandSpec, opts) {
  try {
    const result = await runCommandProbe(spawnInteractive, commandSpec, opts);
    if (result.code === 0) {
      return result.stdout.trim().split(/\r?\n/).find(Boolean) || null;
    }
    if (result.code === 127) {
      throw new UsageProbeError('not_installed', `${commandSpec.command} is not installed`);
    }
    throw new UsageProbeError('probe_failed', `${commandSpec.command} version probe failed`);
  } catch (err) {
    if (err instanceof UsageProbeError) throw err;
    // A non-probe throw here is a local/transport-side failure (spawn threw,
    // pathPrefix rejected, …) — the remote CLI's absence is only ever proven
    // by exit 127, so do NOT map this to not_installed (Codex R2 finding 4).
    throw new UsageProbeError('probe_failed', `${commandSpec.command} version probe failed`);
  }
}

function closeInfoToRpcError(closeInfo) {
  if (closeInfo?.code === 255) return new UsageProbeError('transport_lost', 'ssh transport lost');
  return new UsageProbeError('probe_failed', 'codex app-server exited');
}

async function runCodexRpcProbe(spawnInteractive, opts) {
  return withProbeChild(spawnInteractive, COMMANDS.codexAppServer, opts, async ({
    child,
    output,
    closePromise,
    onStdout,
  }) => {
    let nextId = 1;
    let buffer = '';
    const pending = new Map();

    onStdout((chunk) => {
      buffer += chunk;
      let index;
      while ((index = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        if (!line) continue;
        let payload;
        try {
          payload = JSON.parse(line);
        } catch {
          continue;
        }
        const pendingRequest = pending.get(payload.id);
        if (!pendingRequest) continue;
        pending.delete(payload.id);
        pendingRequest.resolve(payload);
      }
    });

    closePromise.then((info) => {
      const err = closeInfoToRpcError(info);
      for (const pendingRequest of pending.values()) pendingRequest.reject(err);
      pending.clear();
    });

    function request(method, params) {
      const id = nextId;
      nextId += 1;
      const payload = {
        jsonrpc: '2.0',
        id,
        method,
        ...(params ? { params } : {}),
      };
      const responsePromise = new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
      });
      try {
        child.stdin.write(`${JSON.stringify(payload)}\n`);
      } catch {
        pending.delete(id);
        throw new UsageProbeError('probe_failed', 'failed to write to codex app-server');
      }
      return responsePromise;
    }

    const init = await request('initialize', { clientInfo: { name: 'palantir-console', version: '1.0.0' } });
    if (init.error && init.error?.message !== 'Already initialized') {
      throw new UsageProbeError('probe_failed', 'codex app-server init failed');
    }

    let account = null;
    let requiresOpenaiAuth = null;
    let accountError = null;
    const accountResponse = await request('account/read', { refreshToken: false });
    if (accountResponse?.result) {
      account = accountResponse.result.account || null;
      requiresOpenaiAuth = accountResponse.result.requiresOpenaiAuth ?? null;
    } else if (accountResponse?.error) {
      // Remote probe is a NEW wire surface — never pass a raw JSON-RPC error
      // object (message/data/internal codes) through to the client. The local
      // provider path keeps its existing pass-through parity; only this remote
      // path sanitizes (Codex R2 finding 5).
      accountError = { message: sanitizeMessage(accountResponse.error.message || 'account read failed') };
    }

    const limitsResponse = await request('account/rateLimits/read', null);
    if (limitsResponse.error) {
      throw new UsageProbeError('probe_failed', 'codex rate limit probe failed');
    }
    // requiresOpenaiAuth is passed through as data, mirroring the local
    // codexService.getStatus() semantics — a ChatGPT-plan pod login returns
    // true here while still serving real rate limits (proven on the real Pi;
    // treating it as not_logged_in wrongly degraded a healthy card).

    const limits = formatLimits(limitsResponse.result || {});
    if (!limits || !limits.length) {
      throw new UsageProbeError('no_data', 'No rate limit data available');
    }

    maybeEndStdin(child);
    return {
      limits,
      account,
      requiresOpenaiAuth,
      accountError,
      updatedAt: nowIso(),
    };
  });
}

function providerIdToCliId(providerId) {
  const id = String(providerId || '').toLowerCase();
  if (id === 'codex' || id === 'openai') return 'codex';
  if (id === 'anthropic' || id === 'claude' || id === 'claude-code') return 'claude';
  if (id === 'gemini' || id === 'google') return 'gemini';
  return id || 'unknown';
}

function providerToUsage(provider) {
  const usage = {
    limits: Array.isArray(provider?.limits) ? provider.limits : [],
    account: provider?.account ?? null,
    updatedAt: provider?.updatedAt || nowIso(),
  };
  if ('requiresOpenaiAuth' in (provider || {})) usage.requiresOpenaiAuth = provider.requiresOpenaiAuth;
  if ('accountError' in (provider || {})) usage.accountError = provider.accountError;
  return usage;
}

async function getLocalCards(providerRegistry, fetchClaudeCode) {
  if (!providerRegistry || typeof providerRegistry.fetchAllRegistered !== 'function') {
    return [
      errorCard('codex', 'no_data', 'provider registry unavailable'),
      errorCard('claude', 'no_data', 'provider registry unavailable'),
      errorCard('gemini', 'no_data', 'provider registry unavailable'),
    ];
  }

  let providers;
  try {
    providers = await providerRegistry.fetchAllRegistered();
  } catch {
    return [
      errorCard('codex', 'no_data', 'No rate limit data available'),
      errorCard('claude', 'no_data', 'No rate limit data available'),
      errorCard('gemini', 'no_data', 'No rate limit data available'),
    ];
  }

  // Node semantics are "CLIs on this node", not "providers registered in
  // opencode auth.json". The registry's anthropic entry is the API-key
  // account (a different auth source than the claude CLI), so it never
  // produces the claude card here — the claude-code adapter below is the
  // single source for it (Codex review: an anthropic key must not mask the
  // keychain-authenticated CLI).
  const cards = (providers || [])
    .map((provider) => {
      const id = providerIdToCliId(provider?.id);
      return card(id, {
        installed: true,
        usage: providerToUsage(provider),
        updatedAt: provider?.updatedAt,
      });
    })
    .filter((item) => ['codex', 'gemini'].includes(item.id));

  try {
    const provider = await fetchClaudeCode();
    if (provider) {
      cards.push(card('claude', {
        installed: true,
        usage: providerToUsage(provider),
        updatedAt: provider?.updatedAt,
      }));
    } else {
      cards.push(errorCard('claude', 'no_data', 'No rate limit data available'));
    }
  } catch {
    cards.push(errorCard('claude', 'no_data', 'No rate limit data available'));
  }

  // Canonical card order regardless of registry/augmentation arrival order.
  const order = { codex: 0, claude: 1, gemini: 2 };
  cards.sort((a, b) => (order[a.id] ?? 9) - (order[b.id] ?? 9));
  return cards;
}

async function getClaudeAuthStatus(spawnInteractive, opts) {
  const result = await runCommandProbe(spawnInteractive, COMMANDS.claudeAuthStatus, opts);
  if (result.code === 255) throw new UsageProbeError('transport_lost', 'ssh transport lost');
  if (result.code !== 0) throw new UsageProbeError('not_logged_in', 'claude is not logged in');
  let parsed;
  try {
    parsed = JSON.parse(result.stdout || '{}');
  } catch {
    throw new UsageProbeError('probe_failed', 'claude auth status returned invalid JSON');
  }
  const authStatus = {};
  for (const key of ['loggedIn', 'email', 'planType', 'orgName']) {
    if (Object.prototype.hasOwnProperty.call(parsed, key)) authStatus[key] = parsed[key];
  }
  if (authStatus.loggedIn === false) {
    throw new UsageProbeError('not_logged_in', 'claude is not logged in');
  }
  return authStatus;
}

async function getSshCodexCard(node, spawnInteractive, opts) {
  let version = null;
  try {
    version = await probeVersion(spawnInteractive, COMMANDS.codexVersion, opts);
  } catch (err) {
    const normalized = normalizeUsageError(err);
    return errorCard('codex', normalized.code, normalized.message, {
      installed: normalized.code === 'not_installed' ? false : null,
    });
  }

  try {
    const usage = await runCodexRpcProbe(spawnInteractive, opts);
    return card('codex', {
      installed: true,
      version,
      usage,
    });
  } catch (err) {
    const normalized = normalizeUsageError(err);
    return errorCard('codex', normalized.code, normalized.message, {
      installed: true,
      version,
    });
  }
}

async function getSshClaudeCard(node, spawnInteractive, opts) {
  let version = null;
  try {
    version = await probeVersion(spawnInteractive, COMMANDS.claudeVersion, opts);
  } catch (err) {
    const normalized = normalizeUsageError(err);
    return errorCard('claude', normalized.code, normalized.message, {
      installed: normalized.code === 'not_installed' ? false : null,
    });
  }

  try {
    const authStatus = await getClaudeAuthStatus(spawnInteractive, opts);
    return errorCard('claude', 'quota_unsupported', 'claude quota lookup is not supported in v1', {
      installed: true,
      version,
      authStatus,
    });
  } catch (err) {
    const normalized = normalizeUsageError(err);
    return errorCard('claude', normalized.code, normalized.message, {
      installed: true,
      version,
    });
  }
}

function createNodeUsageService({
  nodeService,
  providerRegistry,
  fetchClaudeCodeFn = fetchClaudeCodeUsage,
  probeTimeoutMs = DEFAULT_PROBE_TIMEOUT_MS,
  probeKillGraceMs = DEFAULT_PROBE_KILL_GRACE_MS,
  probeMaxOutputBytes = DEFAULT_OUTPUT_MAX_BYTES,
  spawnInteractiveFn = null,
} = {}) {
  if (!nodeService || typeof nodeService.getNode !== 'function') {
    throw new Error('createNodeUsageService requires nodeService');
  }

  function probeOptionsFor(node) {
    return {
      pathPrefix: node.node_prefix || undefined,
      timeoutMs: probeTimeoutMs,
      killGraceMs: probeKillGraceMs,
      maxOutputBytes: probeMaxOutputBytes,
    };
  }

  async function getUsageSnapshot(nodeId) {
    const node = nodeService.getNode(nodeId);
    let clis;
    if (!node.kind || node.kind === 'local') {
      clis = await getLocalCards(providerRegistry, fetchClaudeCodeFn);
    } else if (node.kind === 'ssh') {
      if (Number(node.reachable) === 0) {
        clis = [
          errorCard('codex', 'transport_lost', 'node unreachable'),
          errorCard('claude', 'transport_lost', 'node unreachable'),
        ];
      } else {
        let spawnInteractive = spawnInteractiveFn;
        if (!spawnInteractive) {
          try {
            // pickExecutor can throw on malformed node rows (bad exposed_roots
            // JSON, …). The node exists, so this is a probe failure per card —
            // never an HTTP 500 (Codex R2 finding 6).
            const executor = nodeService.pickExecutor(node.id);
            spawnInteractive = executor.spawnInteractive.bind(executor);
          } catch (err) {
            const normalized = normalizeUsageError(err, 'probe_failed', 'node executor unavailable');
            clis = [
              errorCard('codex', normalized.code, normalized.message),
              errorCard('claude', normalized.code, normalized.message),
            ];
          }
        }
        if (spawnInteractive) {
          const opts = probeOptionsFor(node);
          clis = await Promise.all([
            getSshCodexCard(node, spawnInteractive, opts),
            getSshClaudeCard(node, spawnInteractive, opts),
          ]);
        }
      }
    } else {
      clis = [
        errorCard('codex', 'probe_failed', `unsupported node kind: ${node.kind}`),
        errorCard('claude', 'probe_failed', `unsupported node kind: ${node.kind}`),
      ];
    }

    return {
      node: nodeEnvelope(node),
      clis,
      updatedAt: nowIso(),
    };
  }

  return {
    getUsageSnapshot,
  };
}

module.exports = {
  createNodeUsageService,
  ERROR_CODES,
};
