const { spawn } = require('child_process');
const { AppError } = require('../utils/errors');

const DEFAULT_TIMEOUT_MS = 8000;

function labelFromWindow(windowMinutes, fallback) {
  if (!windowMinutes) return fallback;
  if (windowMinutes >= 10080) return 'weekly limit';
  if (windowMinutes % 60 === 0) return `${Math.round(windowMinutes / 60)}h limit`;
  return `${windowMinutes}m limit`;
}

function parseRateLimits(payload) {
  const limits = [];

  if (payload.rateLimits && typeof payload.rateLimits === 'object' && !Array.isArray(payload.rateLimits)) {
    const primary = payload.rateLimits.primary || null;
    const secondary = payload.rateLimits.secondary || null;
    if (primary) limits.push({ label: 'primary', data: primary });
    if (secondary) limits.push({ label: 'secondary', data: secondary });
  } else if (Array.isArray(payload.rateLimits)) {
    payload.rateLimits.forEach((item) => {
      if (item && typeof item === 'object') limits.push({ label: item.label || item.name || 'limit', data: item });
    });
  } else if (Array.isArray(payload.rate_limits)) {
    payload.rate_limits.forEach((item) => {
      if (item && typeof item === 'object') limits.push({ label: item.label || item.name || 'limit', data: item });
    });
  }

  return limits;
}

function extractRemainingPct(data) {
  if (!data) return null;
  const remaining = data.remaining_pct ?? data.remainingPct;
  if (typeof remaining === 'number') return remaining;
  const usedPercent = data.usedPercent ?? data.used_percent;
  if (typeof usedPercent === 'number') return Math.max(0, Math.min(100, 100 - usedPercent));
  const utilization = data.utilization;
  if (typeof utilization === 'number') return Math.max(0, Math.min(100, 100 - utilization));
  return null;
}

function extractResetAt(data) {
  const raw = data?.resets_at ?? data?.reset_at ?? data?.resetsAt;
  if (typeof raw === 'number') {
    const ms = raw > 1_000_000_000_000 ? raw : raw * 1000;
    return new Date(ms);
  }
  if (typeof raw === 'string') {
    const parsed = Date.parse(raw);
    if (!Number.isNaN(parsed)) return new Date(parsed);
  }
  return null;
}

function formatLimits(payload) {
  const items = parseRateLimits(payload);
  if (!items.length) return null;

  return items
    .filter((item) => item.label !== 'credits')
    .map((item) => {
      const windowMinutes =
        item.data?.windowDurationMins
        ?? item.data?.window_minutes
        ?? item.data?.windowMinutes;
      const label = item.label === 'primary' || item.label === 'secondary'
        ? labelFromWindow(windowMinutes, `${item.label} limit`)
        : String(item.label);
      return {
        label,
        remainingPct: extractRemainingPct(item.data),
        resetAt: extractResetAt(item.data)
      };
    })
    .filter(Boolean);
}

class AppServerSession {
  constructor(command, env) {
    this.command = command;
    this.env = env;
    this.process = null;
    this.buffer = '';
    this.pending = new Map();
    this.nextId = 1;
    this.initialized = false;
  }

  start() {
    if (this.process) return;
    this.process = spawn(this.command[0], this.command.slice(1), {
      env: this.env,
      stdio: ['pipe', 'pipe', 'pipe']
    });

    this.process.stdout.setEncoding('utf8');
    this.process.stdout.on('data', (chunk) => this._onData(chunk));
    this.process.on('exit', () => this._onExit());
  }

  stop() {
    if (!this.process) return;
    try {
      this.process.kill();
    } catch (err) {
      // ignore
    }
    this.process = null;
    this.initialized = false;
  }

  _onExit() {
    for (const { reject } of this.pending.values()) {
      reject(new AppError('codex app-server exited', 500));
    }
    this.pending.clear();
    this.process = null;
    this.initialized = false;
  }

  _onData(chunk) {
    this.buffer += chunk;
    let index;
    while ((index = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, index).trim();
      this.buffer = this.buffer.slice(index + 1);
      if (!line) continue;
      let payload;
      try {
        payload = JSON.parse(line);
      } catch (err) {
        continue;
      }
      const id = payload.id;
      if (typeof id !== 'number') continue;
      const pending = this.pending.get(id);
      if (!pending) continue;
      this.pending.delete(id);
      pending.resolve(payload);
    }
  }

  request(method, params, timeoutMs = DEFAULT_TIMEOUT_MS) {
    return new Promise((resolve, reject) => {
      this.start();
      const id = this.nextId;
      this.nextId += 1;
      const payload = {
        jsonrpc: '2.0',
        id,
        method,
        ...(params ? { params } : {})
      };

      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new AppError('timeout waiting for app-server response', 504));
      }, timeoutMs);

      this.pending.set(id, {
        resolve: (response) => {
          clearTimeout(timeout);
          resolve(response);
        },
        reject: (err) => {
          clearTimeout(timeout);
          reject(err);
        }
      });

      if (!this.process || !this.process.stdin) {
        clearTimeout(timeout);
        this.pending.delete(id);
        reject(new AppError('app-server not running', 500));
        return;
      }
      try {
        this.process.stdin.write(`${JSON.stringify(payload)}\n`);
      } catch (err) {
        clearTimeout(timeout);
        this.pending.delete(id);
        reject(new AppError('failed to write to app-server', 500, err.message));
      }
    });
  }
}

function createCodexService({ codexBin, codexHome, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  const env = {
    ...process.env,
    CODEX_HOME: codexHome
  };
  const session = new AppServerSession([codexBin, 'app-server'], env);

  async function getStatus() {
    if (!session.initialized) {
      const init = await session.request(
        'initialize',
        { clientInfo: { name: 'palantir-console', version: '1.0.0' } },
        timeoutMs
      );
      if (init.error && init.error?.message !== 'Already initialized') {
        throw new AppError('codex app-server init failed', 500, JSON.stringify(init.error));
      }
      session.initialized = true;
    }

    let account = null;
    let requiresOpenaiAuth = null;
    let accountError = null;
    const accountResponse = await session.request('account/read', { refreshToken: false }, timeoutMs);
    if (accountResponse?.result) {
      account = accountResponse.result.account || null;
      requiresOpenaiAuth = accountResponse.result.requiresOpenaiAuth ?? null;
    } else if (accountResponse?.error) {
      accountError = accountResponse.error;
    }

    const response = await session.request('account/rateLimits/read', null, timeoutMs);
    if (response.error) {
      throw new AppError('codex app-server error', 500, JSON.stringify(response.error));
    }

    const result = response.result || {};
    const lines = formatLimits(result);
    if (!lines || !lines.length) {
      throw new AppError('No rate limit data available', 404, JSON.stringify(result).slice(0, 200));
    }
    return {
      limits: lines,
      updatedAt: new Date().toISOString(),
      account,
      requiresOpenaiAuth,
      accountError
    };
  }

  async function getProviderStatus() {
    const status = await getStatus();
    return {
      id: 'codex',
      name: 'Codex',
      ...status
    };
  }

  return { getStatus, getProviderStatus };
}

module.exports = { createCodexService };
