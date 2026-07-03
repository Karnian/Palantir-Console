const childProcess = require('node:child_process');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

/**
 * NodeExecutor is the transport-neutral seam between the control plane and a
 * future execution node. The full contract from the fleet brief is:
 *
 * - exec(command, args, { cwd, env, timeoutMs, maxBuffer }) -> { code, stdout, stderr }
 * - spawnInteractive(command, args, opts) plus getOutput/sendInput/kill/detectExitCode
 * - liveness(runId) -> 'alive' | 'dead' | 'unreachable'
 * - listSessions() / discoverGhostSessions()
 * - realpath / fileExists / stat / mkdir / readFile / writeTempFile / readdir / rmrf
 * - putSecretFile(path, content, mode = 0o600) with cleanup hooks
 *
 * It intentionally does not provide throwing placeholders for spawnInteractive,
 * liveness, session discovery, or putSecretFile; those methods are added in
 * later phases.
 */
function createLocalWorkerChannel({ streamJsonEngine, executionEngine } = {}) {
  function requireEngine(engineName, method) {
    const engine = engineName === 'stream-json' ? streamJsonEngine : executionEngine;
    if (!engine || typeof engine[method] !== 'function') {
      throw new Error(`Local worker channel ${engineName} engine is not attached or does not implement ${method}`);
    }
    return engine;
  }

  function streamJsonOwns(runId) {
    return Boolean(
      streamJsonEngine
      && typeof streamJsonEngine.hasProcess === 'function'
      && streamJsonEngine.hasProcess(runId),
    );
  }

  function executionSessionOwns(runId) {
    if (!executionEngine || typeof executionEngine.listSessions !== 'function') return false;
    const rawRunId = String(runId);
    const safeRunId = rawRunId.replace(/[^a-zA-Z0-9_-]/g, '_');
    const expectedNames = new Set([
      `palantir-run-${safeRunId}`,
      `subprocess-${rawRunId}`,
      `subprocess-${safeRunId}`,
    ]);
    try {
      const sessions = executionEngine.listSessions() || [];
      return sessions.some((session) => {
        if (!session) return false;
        if (session.runId === runId || String(session.runId || '') === rawRunId) return true;
        return expectedNames.has(String(session.name || ''));
      });
    } catch {
      return false;
    }
  }

  function executionOwns(runId) {
    if (!executionEngine) return false;
    if (typeof executionEngine.isAlive === 'function' && executionEngine.isAlive(runId)) return true;
    if (executionSessionOwns(runId)) return true;
    if (executionEngine.type) return true;
    return Boolean(
      typeof executionEngine.detectExitCode === 'function'
      && executionEngine.detectExitCode(runId) !== null,
    );
  }

  function ownerOf(runId) {
    if (streamJsonOwns(runId)) return 'stream-json';
    if (executionOwns(runId)) return 'cli';
    return null;
  }

  function spawnWorker(runId, { engine, spec } = {}) {
    if (engine === 'stream-json') {
      return requireEngine('stream-json', 'spawnAgent').spawnAgent(runId, spec);
    }
    if (engine === 'cli') {
      return requireEngine('cli', 'spawnAgent').spawnAgent(runId, spec);
    }
    throw new Error(`Local worker channel cannot spawn unknown worker engine: ${engine}`);
  }

  function isAlive(runId, engine) {
    const resolved = engine || ownerOf(runId);
    if (!resolved) return false;
    return requireEngine(resolved, 'isAlive').isAlive(runId);
  }

  function detectExitCode(runId, engine) {
    const resolved = engine || ownerOf(runId);
    if (!resolved) return null;
    return requireEngine(resolved, 'detectExitCode').detectExitCode(runId);
  }

  function getOutput(runId, lines) {
    return requireEngine('cli', 'getOutput').getOutput(runId, lines);
  }

  function sendInput(runId, text) {
    const sentByStream = streamJsonEngine
      ? requireEngine('stream-json', 'sendInput').sendInput(runId, text)
      : false;
    return sentByStream || requireEngine('cli', 'sendInput').sendInput(runId, text);
  }

  function kill(runId, engine) {
    if (engine === 'stream-json') {
      return requireEngine('stream-json', 'kill').kill(runId);
    }
    if (engine === 'cli') {
      return requireEngine('cli', 'kill').kill(runId);
    }
    const killedByStream = streamJsonEngine
      ? requireEngine('stream-json', 'kill').kill(runId)
      : false;
    if (!killedByStream) {
      return requireEngine('cli', 'kill').kill(runId);
    }
    return killedByStream;
  }

  function cleanupRun() {
    return Promise.resolve();
  }

  return {
    spawnWorker,
    ownerOf,
    isAlive,
    detectExitCode,
    getOutput,
    sendInput,
    kill,
    cleanupRun,
  };
}

function createLocalNodeExecutor({ executionEngine, streamJsonEngine } = {}) {
  let workerChannel = (executionEngine || streamJsonEngine)
    ? createLocalWorkerChannel({ executionEngine, streamJsonEngine })
    : null;
  let api;

  function requireWorkerChannel(method) {
    if (!workerChannel) {
      throw new Error(`LocalNodeExecutor worker channel is not attached; call attachEngines(...) before ${method}`);
    }
    return workerChannel;
  }

  function attachEngines(engines = {}) {
    workerChannel = createLocalWorkerChannel(engines);
    return api;
  }

  /**
   * Run a command to completion. Resolves { code, stdout, stderr } only for
   * genuine process exits (including nonzero codes). Rejects for operational
   * failures — spawn errors (ENOENT), timeout/signal kills, maxBuffer overflow
   * — with partial stdout/stderr attached to the error so callers that can
   * salvage output (e.g. truncated diffs) may do so. Remote executors must
   * emulate or cap maxBuffer with the same rejection contract. Collapsing
   * operational failures into a fake exit code would make "command failed"
   * indistinguishable from "transport/limit failed" once executors go remote.
   */
  function exec(command, args = [], { cwd, env, timeoutMs, maxBuffer } = {}) {
    return new Promise((resolve, reject) => {
      childProcess.execFile(
        command,
        args,
        {
          cwd,
          env: env ? { ...process.env, ...env } : undefined,
          timeout: timeoutMs,
          maxBuffer,
          encoding: 'utf-8',
        },
        (err, stdout, stderr) => {
          if (!err) {
            resolve({ code: 0, stdout: String(stdout || ''), stderr: String(stderr || '') });
            return;
          }
          // A numeric code with no kill signal is a genuine process exit.
          if (typeof err.code === 'number' && !err.signal && !err.killed) {
            resolve({ code: err.code, stdout: String(stdout || ''), stderr: String(stderr || '') });
            return;
          }
          err.stdout = String(stdout || '');
          err.stderr = String(stderr || '');
          reject(err);
        },
      );
    });
  }

  async function fileExists(p) {
    try {
      await fsp.access(p);
      return true;
    } catch {
      return false;
    }
  }

  async function writeTempFile(prefix, name, content, mode = 0o600) {
    // Secrets/config material will flow through here in later phases — refuse
    // any name that could escape the fresh mkdtemp directory.
    if (typeof name !== 'string' || name.length === 0 || name !== path.basename(name) || name === '.' || name === '..') {
      throw new Error(`writeTempFile: invalid file name "${name}" (must be a bare filename)`);
    }
    const dir = await fsp.mkdtemp(path.isAbsolute(prefix) ? prefix : path.join(os.tmpdir(), prefix));
    const filePath = path.join(dir, name);
    await fsp.writeFile(filePath, content, { mode });
    await fsp.chmod(filePath, mode);
    return filePath;
  }

  api = {
    exec,
    fileExists,
    realpath: (p) => fsp.realpath(p),
    stat: (p) => fsp.stat(p),
    mkdir: (p, options) => fsp.mkdir(p, options),
    readFile: (p) => fsp.readFile(p, 'utf8'),
    readdir: (p, options) => fsp.readdir(p, options),
    writeTempFile,
    rmrf: (p) => fsp.rm(p, { recursive: true, force: true }),
    attachEngines,
    spawnWorker: (...args) => requireWorkerChannel('spawnWorker').spawnWorker(...args),
    ownerOf: (...args) => requireWorkerChannel('ownerOf').ownerOf(...args),
    isAlive: (...args) => requireWorkerChannel('isAlive').isAlive(...args),
    detectExitCode: (...args) => requireWorkerChannel('detectExitCode').detectExitCode(...args),
    getOutput: (...args) => requireWorkerChannel('getOutput').getOutput(...args),
    sendInput: (...args) => requireWorkerChannel('sendInput').sendInput(...args),
    kill: (...args) => requireWorkerChannel('kill').kill(...args),
    cleanupRun: (...args) => requireWorkerChannel('cleanupRun').cleanupRun(...args),
  };
  return api;
}

module.exports = {
  createLocalWorkerChannel,
  createLocalNodeExecutor,
};
