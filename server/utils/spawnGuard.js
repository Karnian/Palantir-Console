const fs = require('node:fs');
const path = require('node:path');
const { AppError } = require('./errors');

const FIXTURE_ROOT = path.resolve(__dirname, '..', 'tests', 'fixtures');
const ERROR_CODE = 'PALANTIR_SPAWN_BLOCKED';

class SpawnBlockedError extends AppError {
  constructor({ source, command, resolvedCommand, reason }) {
    const commandLabel = typeof command === 'string' ? command : String(command);
    const resolvedLabel = resolvedCommand ? ` (resolved: ${resolvedCommand})` : '';
    super(
      `Spawn blocked by test guard at ${source || 'unknown'}: ${commandLabel}${resolvedLabel}`,
      500,
      {
        code: ERROR_CODE,
        source: source || null,
        command: commandLabel,
        resolvedCommand: resolvedCommand || null,
        reason: reason || 'blocked',
      }
    );
    this.name = 'SpawnBlockedError';
    this.code = ERROR_CODE;
  }
}

function isSpawnGuardActive() {
  const testContextPresent = Object.prototype.hasOwnProperty.call(process.env, 'NODE_TEST_CONTEXT');
  const explicitlyBlocked = process.env.PALANTIR_BLOCK_REAL_SPAWN === '1';
  const explicitlyAllowed = process.env.PALANTIR_ALLOW_REAL_SPAWN === '1';
  return (testContextPresent || explicitlyBlocked) && !explicitlyAllowed;
}

function realpathOrNull(candidate) {
  try {
    return fs.realpathSync(candidate);
  } catch {
    return null;
  }
}

function canExecute(candidate) {
  try {
    fs.accessSync(candidate, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function hasPathSeparator(command) {
  return command.includes('/') || (path.sep === '\\' && command.includes('\\'));
}

function resolveBareCommand(command) {
  const pathValue = process.env.PATH || '';
  for (const entry of pathValue.split(path.delimiter)) {
    if (!entry) continue;
    const candidate = path.join(entry, command);
    if (canExecute(candidate)) {
      return realpathOrNull(candidate) || path.resolve(candidate);
    }
  }
  return null;
}

function resolveCommand(command) {
  if (!command || typeof command !== 'string') {
    return { resolvedCommand: null, reason: 'invalid_command' };
  }

  if (path.isAbsolute(command) || hasPathSeparator(command)) {
    const candidate = path.resolve(command);
    if (!canExecute(candidate)) {
      return { resolvedCommand: realpathOrNull(candidate), reason: 'not_executable_or_missing' };
    }
    return { resolvedCommand: realpathOrNull(candidate) || candidate, reason: null };
  }

  const resolved = resolveBareCommand(command);
  if (!resolved) return { resolvedCommand: null, reason: 'path_resolution_failed' };
  return { resolvedCommand: resolved, reason: null };
}

function isSameExecutable(a, b) {
  const realA = realpathOrNull(a) || path.resolve(a);
  const realB = realpathOrNull(b) || path.resolve(b);
  return realA === realB;
}

function isWithinFixtureRoot(resolvedCommand) {
  if (!resolvedCommand) return false;
  const fixtureRoot = realpathOrNull(FIXTURE_ROOT) || FIXTURE_ROOT;
  return resolvedCommand === fixtureRoot || resolvedCommand.startsWith(fixtureRoot + path.sep);
}

function isAllowedResolvedCommand(resolvedCommand) {
  if (!resolvedCommand) return false;
  if (isSameExecutable(resolvedCommand, process.execPath)) return true;
  return isWithinFixtureRoot(resolvedCommand);
}

function assertSpawnAllowed({ command, source } = {}) {
  if (!isSpawnGuardActive()) return;

  const { resolvedCommand, reason } = resolveCommand(command);
  if (isAllowedResolvedCommand(resolvedCommand)) return;

  throw new SpawnBlockedError({
    source,
    command,
    resolvedCommand,
    reason: reason || 'outside_allowed_spawn_roots',
  });
}

module.exports = {
  assertSpawnAllowed,
  isSpawnGuardActive,
  SpawnBlockedError,
};
