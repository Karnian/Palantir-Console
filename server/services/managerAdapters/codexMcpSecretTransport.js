/**
 * File-backed transport for secret-bearing stdio MCP environment values.
 *
 * Codex has no per-invocation MCP config-file flag. Palantir therefore keeps
 * the existing highest-precedence leaf-level `-c mcp_servers.*` overrides,
 * but replaces an env-bearing stdio server with a tiny Node wrapper:
 *
 *   command = "/absolute/path/to/node"
 *   args = ["/0600/secret-wrapper.cjs", "alias"]
 *   env.NODE_OPTIONS = "" // non-secret hardening of wrapper startup
 *
 * The wrapper reads the original command/args/env from its own mode-0600 file
 * and spawns the real server with the exact Palantir env overlay. Consequently
 * no Palantir env VALUE reaches Codex's argv, while `-c` keeps the precedence
 * semantics that profiles/project config files cannot provide.
 */

const path = require('node:path');
const { flattenMcpToCodexArgs } = require('./codexMcpFlatten');

const WRAPPER_FILENAME = 'codex-mcp-stdio-env.cjs';
const KEY_RE = /^[A-Za-z0-9_-]+$/;
// A lower-precedence ~/.codex/config.toml env table deep-merges even when the
// invocation also passes alias.env={}. These variables can affect the new Node
// wrapper before its JS runs or make child_process debug output disclose the
// secret env overlay. Override only those interpreter-sensitive keys with
// non-secret empty strings; all ordinary legacy env keys keep flowing through
// process.env to the real MCP child, preserving prior leaf-merge behavior.
const WRAPPER_BOOT_ENV_KEYS = [
  'NODE_OPTIONS',
  'NODE_DEBUG',
  'NODE_DEBUG_NATIVE',
  'NODE_V8_COVERAGE',
  'NODE_COMPILE_CACHE',
];
const SECRET_CLEANUP_ATTEMPTS = 3;
const SECRET_CLEANUP_RETRY_MS = 25;

function isThenable(value) {
  return Boolean(value && typeof value.then === 'function');
}

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function removeSecretDirWithRetry(executor, dir, {
  attempts = SECRET_CLEANUP_ATTEMPTS,
  retryMs = SECRET_CLEANUP_RETRY_MS,
} = {}) {
  if (!executor || typeof executor.rmrf !== 'function') {
    throw new Error('codexMcpSecretTransport: executor.rmrf is required for secret cleanup');
  }
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      await executor.rmrf(dir);
      return;
    } catch (err) {
      lastError = err;
      if (attempt < attempts && retryMs > 0) await wait(retryMs * attempt);
    }
  }
  throw lastError;
}

function effectiveEnv(env) {
  if (!env || typeof env !== 'object' || Array.isArray(env)) return null;
  const entries = Object.entries(env).filter(([, value]) => value !== null && value !== undefined);
  return entries.length > 0 ? Object.fromEntries(entries) : null;
}

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * Validate both the existing Codex TOML contract and the extra requirements
 * needed to faithfully relay an env-bearing stdio process through a wrapper.
 * This is synchronous so codexAdapter.runTurn can still fail closed before it
 * reports `{ accepted: true }`.
 */
function validateCodexMcpSecretTransport(mcpConfig) {
  const wrapped = Object.create(null);
  if (!isPlainObject(mcpConfig) || !isPlainObject(mcpConfig.mcpServers)) {
    return { flatArgs: flattenMcpToCodexArgs(mcpConfig), wrapped };
  }
  const servers = mcpConfig.mcpServers;
  const sanitizedServers = Object.create(null);

  for (const [alias, cfg] of Object.entries(servers)) {
    // HTTP MCP uses bearer_token_env_var (an env NAME) and remains byte-for-byte
    // on the normal flatten path. Only stdio's literal env map is file-backed.
    if (!isPlainObject(cfg) || Object.prototype.hasOwnProperty.call(cfg, 'url')) {
      sanitizedServers[alias] = cfg;
      continue;
    }
    const env = effectiveEnv(cfg.env);
    if (!env) {
      sanitizedServers[alias] = cfg;
      continue;
    }

    for (const [envKey, envValue] of Object.entries(cfg.env)) {
      if (!KEY_RE.test(envKey)) {
        throw new Error(
          `flattenMcpToCodexArgs: invalid env key under ${alias} "${envKey}" (must match ${KEY_RE})`,
        );
      }
      if (envValue !== null && envValue !== undefined && typeof envValue !== 'string') {
        throw new Error(
          `flattenMcpToCodexArgs: env value for ${alias}.env.${envKey} must be a string (got ${typeof envValue})`,
        );
      }
    }

    if (typeof cfg.command !== 'string' || cfg.command.length === 0) {
      throw new Error(
        `codexMcpSecretTransport: stdio alias "${alias}" has env values but no concrete command; ` +
        'refusing to fall back to secret-bearing argv',
      );
    }
    if (cfg.command.includes('\0')) {
      throw new Error(`codexMcpSecretTransport: stdio alias "${alias}" command contains NUL`);
    }
    if (cfg.args !== null && cfg.args !== undefined) {
      if (!Array.isArray(cfg.args) || cfg.args.some(arg => typeof arg !== 'string')) {
        throw new Error(
          `codexMcpSecretTransport: stdio alias "${alias}" args must be an array of strings when env is present`,
        );
      }
      const nulArgIndex = cfg.args.findIndex(arg => arg.includes('\0'));
      if (nulArgIndex !== -1) {
        throw new Error(
          `codexMcpSecretTransport: stdio alias "${alias}" args[${nulArgIndex}] contains NUL`,
        );
      }
    }
    for (const [envKey, envValue] of Object.entries(env)) {
      if (envValue.includes('\0')) {
        throw new Error(
          `codexMcpSecretTransport: env value for ${alias}.env.${envKey} contains NUL`,
        );
      }
    }

    wrapped[alias] = {
      command: cfg.command,
      args: Array.isArray(cfg.args) ? [...cfg.args] : [],
      env,
    };
    const sanitized = { ...cfg };
    delete sanitized.env;
    sanitizedServers[alias] = sanitized;
  }

  const flatArgs = flattenMcpToCodexArgs({
    ...mcpConfig,
    mcpServers: sanitizedServers,
  });
  return { flatArgs, wrapped };
}

function buildWrapperSource(wrapped) {
  // Double-stringification keeps arbitrary quotes/newlines/unicode as data,
  // never executable source. The file itself is the secret boundary (0600).
  const encoded = JSON.stringify(JSON.stringify(wrapped));
  return `'use strict';
const { spawn } = require('node:child_process');
const { constants } = require('node:os');
const specs = JSON.parse(${encoded});
const alias = process.argv[2];
const spec = Object.prototype.hasOwnProperty.call(specs, alias) ? specs[alias] : null;
if (!spec) {
  process.stderr.write('Palantir MCP wrapper: unknown alias\\n');
  process.exit(64);
}
let child;
try {
  child = spawn(spec.command, spec.args, {
    env: { ...process.env, ...spec.env },
    stdio: 'inherit',
    shell: false,
  });
} catch {
  process.stderr.write('Palantir MCP wrapper spawn failed\\n');
  process.exit(127);
}
let settled = false;
const forwarded = ['SIGINT', 'SIGTERM', 'SIGHUP'];
const handlers = new Map();
for (const signal of forwarded) {
  const handler = () => {
    try { child.kill(signal); } catch { /* child already exited */ }
  };
  handlers.set(signal, handler);
  process.on(signal, handler);
}
function removeSignalHandlers() {
  for (const [signal, handler] of handlers) process.removeListener(signal, handler);
}
child.once('error', () => {
  if (settled) return;
  settled = true;
  removeSignalHandlers();
  process.stderr.write('Palantir MCP wrapper spawn failed\\n');
  process.exit(127);
});
child.once('exit', (code, signal) => {
  if (settled) return;
  settled = true;
  removeSignalHandlers();
  if (signal && process.platform !== 'win32') {
    try {
      process.kill(process.pid, signal);
      return;
    } catch {
      process.exit(128 + ((constants.signals && constants.signals[signal]) || 1));
    }
  }
  process.exit(code === null || code === undefined ? 1 : code);
});
`;
}

function validateWrapperCommand(wrapperCommand) {
  if (
    typeof wrapperCommand !== 'string'
    || wrapperCommand.length === 0
    || !path.isAbsolute(wrapperCommand)
    || /[\x00-\x1f\x7f]/.test(wrapperCommand)
    || path.normalize(wrapperCommand) !== wrapperCommand
  ) {
    throw new Error(
      'codexMcpSecretTransport: Node wrapper runtime must resolve to a safe absolute path',
    );
  }
  return wrapperCommand;
}

function finalizePreparedConfig(mcpConfig, wrapped, wrapperPath, wrapperCommand) {
  const wrappedAliases = Object.keys(wrapped);
  if (wrappedAliases.length === 0) {
    return {
      args: flattenMcpToCodexArgs(mcpConfig),
      secretPath: null,
      secretDirs: [],
    };
  }

  if (typeof wrapperPath !== 'string' || wrapperPath.length === 0 || !path.isAbsolute(wrapperPath)) {
    throw new Error('codexMcpSecretTransport: putSecretFile must return an absolute wrapper path');
  }
  if (/[\x00-\x1f\x7f]/.test(wrapperPath) || path.normalize(wrapperPath) !== wrapperPath) {
    throw new Error('codexMcpSecretTransport: putSecretFile returned an unsafe/non-normalized wrapper path');
  }
  if (path.basename(wrapperPath) !== WRAPPER_FILENAME) {
    throw new Error(`codexMcpSecretTransport: wrapper path must end with ${WRAPPER_FILENAME}`);
  }
  const wrapperDir = path.dirname(wrapperPath);
  if (!wrapperDir || wrapperDir === '.' || wrapperDir === path.parse(wrapperPath).root) {
    throw new Error('codexMcpSecretTransport: refusing unsafe wrapper parent directory');
  }

  const transformedServers = Object.create(null);
  for (const [alias, cfg] of Object.entries(mcpConfig.mcpServers)) {
    if (!Object.prototype.hasOwnProperty.call(wrapped, alias)) {
      transformedServers[alias] = cfg;
      continue;
    }
    const transformed = {
      ...cfg,
      command: wrapperCommand,
      args: [wrapperPath, alias],
    };
    delete transformed.env;
    transformedServers[alias] = transformed;
  }

  const args = flattenMcpToCodexArgs({
    ...mcpConfig,
    mcpServers: transformedServers,
  });

  // User-level alias env is deep-merged by Codex. Keep ordinary keys (the old
  // behavior did too), but neutralize values that can alter/leak from the new
  // Node interpreter before the wrapper has a chance to relay the real child.
  for (const alias of wrappedAliases) {
    for (const envKey of WRAPPER_BOOT_ENV_KEYS) {
      args.push('-c', `mcp_servers.${alias}.env.${envKey}=""`);
    }
  }

  return {
    args,
    secretPath: wrapperPath,
    secretDirs: [wrapperDir],
  };
}

/**
 * Return either a prepared result or a Promise of one, matching the executor's
 * putSecretFile contract. Local codexAdapter placement therefore remains
 * synchronous; remote placement naturally awaits SSH.
 */
function prepareCodexMcpArgs(mcpConfig, {
  putSecretFile,
  onSecretPlaced,
  resolveWrapperCommand,
} = {}) {
  const { flatArgs, wrapped } = validateCodexMcpSecretTransport(mcpConfig);
  if (Object.keys(wrapped).length === 0) {
    return { args: flatArgs, secretPath: null, secretDirs: [] };
  }
  if (typeof putSecretFile !== 'function') {
    throw new Error('codexMcpSecretTransport: executor.putSecretFile is required for stdio MCP env values');
  }

  const resolvedCommand = typeof resolveWrapperCommand === 'function'
    ? resolveWrapperCommand()
    : process.execPath;
  const place = (command) => {
    const wrapperCommand = validateWrapperCommand(command);
    const placed = putSecretFile(WRAPPER_FILENAME, buildWrapperSource(wrapped), 0o600);
    const finish = (wrapperPath) => {
      // Validate the executor result before exposing it to cleanup tracking. In
      // particular, never let dirname('') become '.' and later reach rmrf('.').
      const prepared = finalizePreparedConfig(mcpConfig, wrapped, wrapperPath, wrapperCommand);
      if (typeof onSecretPlaced === 'function') onSecretPlaced(wrapperPath);
      return prepared;
    };
    return isThenable(placed) ? placed.then(finish) : finish(placed);
  };
  return isThenable(resolvedCommand) ? resolvedCommand.then(place) : place(resolvedCommand);
}

module.exports = {
  SECRET_CLEANUP_ATTEMPTS,
  SECRET_CLEANUP_RETRY_MS,
  WRAPPER_FILENAME,
  WRAPPER_BOOT_ENV_KEYS,
  buildWrapperSource,
  prepareCodexMcpArgs,
  removeSecretDirWithRetry,
  validateCodexMcpSecretTransport,
  validateWrapperCommand,
};
