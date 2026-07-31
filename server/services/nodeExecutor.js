const childProcess = require('node:child_process');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { buildExecEnv, buildProjectTestEnv } = require('./execEnvPolicy');

const PROJECT_TEST_BROKER = path.join(__dirname, 'projectTestBroker.js');
const PROJECT_TEST_SPAWN_ERROR_MARKER = '__PALANTIR_PROJECT_TEST_SPAWN_ERROR__';

function projectTestSpawnError(stderr) {
  const text = String(stderr || '');
  const markerIndex = text.lastIndexOf(PROJECT_TEST_SPAWN_ERROR_MARKER);
  if (markerIndex === -1) return null;
  const encoded = text
    .slice(markerIndex + PROJECT_TEST_SPAWN_ERROR_MARKER.length)
    .split(/\r?\n/, 1)[0];
  try {
    const payload = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'));
    const err = new Error(payload.message || 'project test spawn failed');
    for (const key of ['code', 'errno', 'syscall', 'path', 'spawnargs']) {
      if (payload[key] !== undefined) err[key] = payload[key];
    }
    return err;
  } catch {
    return null;
  }
}

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
 * - resolveNodeRuntime() for execution-node MCP wrapper preflight
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
    return Boolean(
      typeof executionEngine.detectExitCode === 'function'
      && executionEngine.detectExitCode(runId) !== null,
    );
  }

  function normalizeEngineIdentity(engine) {
    if (engine === 'stream-json') return 'stream-json';
    if (engine === 'subprocess' || engine === 'tmux' || engine === 'remote' || engine === 'cli') {
      return engine;
    }
    return null;
  }

  // Routing and liveness are deliberately separate. An attached engine tells
  // us which API to call; it is not evidence that this run still has an owner.
  function engineFor(runId, durableEngine = null) {
    const identity = normalizeEngineIdentity(durableEngine);
    if (identity === 'stream-json') return 'stream-json';
    if (identity) return 'cli';
    if (streamJsonOwns(runId)) return 'stream-json';
    if (executionSessionOwns(runId)) return 'cli';
    return null;
  }

  function executionHasHandle(runId) {
    if (!executionEngine) return false;
    try {
      if (typeof executionEngine.hasProcess === 'function' && executionEngine.hasProcess(runId)) {
        return true;
      }
    } catch {
      return false;
    }
    return executionSessionOwns(runId);
  }

  async function ownerState(runId, durableEngine = null) {
    let identity = normalizeEngineIdentity(durableEngine);
    if (!identity) {
      if (streamJsonOwns(runId)) identity = 'stream-json';
      else if (executionHasHandle(runId)) identity = executionEngine?.type || 'subprocess';
      else return 'unknown';
    }

    if (identity === 'stream-json') {
      try {
        if (!streamJsonEngine || typeof streamJsonEngine.hasProcess !== 'function') return 'unknown';
        if (!streamJsonEngine.hasProcess(runId)) return 'unknown';
        if (typeof streamJsonEngine.isUnreachable === 'function' && streamJsonEngine.isUnreachable(runId)) {
          return 'unknown';
        }
        if (await requireEngine('stream-json', 'isAlive').isAlive(runId)) return 'alive';
        const exitCode = await requireEngine('stream-json', 'detectExitCode').detectExitCode(runId);
        return exitCode === null ? 'unknown' : 'dead';
      } catch {
        return 'unknown';
      }
    }

    if (identity === 'tmux') {
      try {
        if (await requireEngine('cli', 'isAlive').isAlive(runId)) return 'alive';
        const exitCode = await requireEngine('cli', 'detectExitCode').detectExitCode(runId);
        return exitCode === null ? 'unknown' : 'dead';
      } catch {
        return 'unknown';
      }
    }

    if (identity === 'subprocess' || identity === 'cli') {
      if (!executionHasHandle(runId)) return 'unknown';
      try {
        if (await requireEngine('cli', 'isAlive').isAlive(runId)) return 'alive';
        const exitCode = await requireEngine('cli', 'detectExitCode').detectExitCode(runId);
        return exitCode === null ? 'unknown' : 'dead';
      } catch {
        return 'unknown';
      }
    }

    return 'unknown';
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
    engineFor,
    ownerState,
    ownerOf,
    isAlive,
    detectExitCode,
    getOutput,
    sendInput,
    kill,
    cleanupRun,
  };
}

/**
 * Build the remote worker channel on the executor's detached tmux/sentinel
 * ownership model. Claude still emits stream-json output, but the controller
 * does not keep the SSH transport as process ownership: an SSH disconnect must
 * never imply that the pod process exited or make a retry overlap it.
 */
function createRemoteWorkerChannel({
  remoteExecutor,
  streamJsonEngine,
  nodePrefix,
  nodeId,
} = {}) {
  if (!remoteExecutor || typeof remoteExecutor !== 'object') {
    throw new Error('Remote worker channel requires a remote executor');
  }

  function requireRemote(method) {
    if (typeof remoteExecutor[method] !== 'function') {
      throw new Error(`Remote worker executor does not implement ${method}`);
    }
    return remoteExecutor[method].bind(remoteExecutor);
  }

  function requireStream(method) {
    if (!streamJsonEngine || typeof streamJsonEngine[method] !== 'function') {
      throw new Error(`Remote worker channel stream-json engine is not attached or does not implement ${method}`);
    }
    return streamJsonEngine[method].bind(streamJsonEngine);
  }

  function spawnWorker(runId, { engine, spec } = {}) {
    if (engine === 'stream-json') {
      const detachedSpec = requireStream('buildDetachedWorkerSpec')(spec || {}, {
        workerPath: nodePrefix || undefined,
      });
      return requireRemote('spawnWorker')(runId, { engine, spec: detachedSpec });
    }
    if (engine === 'cli') {
      return requireRemote('spawnWorker')(runId, { engine, spec });
    }
    throw new Error(`Remote worker channel cannot spawn unknown worker engine: ${engine}`);
  }

  function ownerOf(runId) {
    return requireRemote('ownerOf')(runId);
  }

  function engineFor(_runId, durableEngine = null) {
    return durableEngine === 'stream-json' ? 'stream-json' : 'cli';
  }

  async function ownerState(runId) {
    try {
      const owner = await requireRemote('ownerOf')(runId);
      if (owner === 'alive' || owner === 'dead' || owner === 'unknown') return owner;
      // ownerOf remains a routing-shaped compatibility API on remote
      // executors. The actual tri-state comes from the durable tmux/sentinel
      // probes below; transport rejection is caught as unknown.
      if (await requireRemote('isAlive')(runId, owner || 'cli')) return 'alive';
      const exitCode = await requireRemote('detectExitCode')(runId, 'cli');
      return exitCode === null ? 'unknown' : 'dead';
    } catch {
      // SSH and all other transport/probe failures preserve ownership.
      return 'unknown';
    }
  }

  function isAlive(runId, engine) {
    return requireRemote('isAlive')(runId, engine);
  }

  function detectExitCode(runId, engine) {
    return requireRemote('detectExitCode')(runId, engine);
  }

  function getOutput(runId, lines, engine) {
    return requireRemote('getOutput')(runId, lines, engine);
  }

  function getStructuredResult(runId) {
    return requireRemote('getStructuredResult')(runId);
  }

  function sendInput(runId, text) {
    return requireRemote('sendInput')(runId, text);
  }

  function kill(runId, engine) {
    return requireRemote('kill')(runId, engine);
  }

  return Object.assign(Object.create(remoteExecutor), {
    spawnWorker,
    engineFor,
    ownerState,
    ownerOf,
    isAlive,
    detectExitCode,
    getOutput,
    getStructuredResult,
    sendInput,
    kill,
  });
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
  // projectTest selects a broader positive runtime allowlist for repository
  // tests. A clean broker remains the test process's direct parent, closing the
  // /proc/$PPID/environ bypass that exists when the Console spawns it directly.
  // This is not an OS-user boundary: deployments that grant agent capabilities
  // still require the separate process-isolation policy enforced elsewhere.
  function exec(command, args = [], { cwd, env, timeoutMs, maxBuffer, projectTest = false } = {}) {
    return new Promise((resolve, reject) => {
      const childEnv = projectTest
        ? buildProjectTestEnv(process.env, env)
        : buildExecEnv(process.env, env);
      childProcess.execFile(
        projectTest ? process.execPath : command,
        projectTest ? [PROJECT_TEST_BROKER, command, ...args] : args,
        {
          cwd,
          env: childEnv,
          timeout: timeoutMs,
          maxBuffer,
          encoding: 'utf-8',
        },
        (err, stdout, stderr) => {
          if (!err) {
            resolve({ code: 0, stdout: String(stdout || ''), stderr: String(stderr || '') });
            return;
          }
          if (projectTest) {
            const spawnErr = projectTestSpawnError(stderr);
            if (spawnErr) {
              spawnErr.stdout = String(stdout || '');
              spawnErr.stderr = String(stderr || '');
              reject(spawnErr);
              return;
            }
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
    try {
      await fsp.writeFile(filePath, content, { mode });
      await fsp.chmod(filePath, mode);
      return filePath;
    } catch (err) {
      try { await fsp.rm(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
      throw err;
    }
  }

  function putSecretFile(name, content, mode = 0o600) {
    return writeTempFile(path.join(os.tmpdir(), 'palantir-secret-'), name, content, mode);
  }

  function resolveNodeRuntime() {
    return process.execPath;
  }

  function spawnInteractive(command, args = [], { cwd, env } = {}) {
    return childProcess.spawn(command, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
  }

  api = {
    exec,
    spawnInteractive,
    fileExists,
    realpath: (p) => fsp.realpath(p),
    stat: (p) => fsp.stat(p),
    mkdir: (p, options) => fsp.mkdir(p, options),
    readFile: (p) => fsp.readFile(p, 'utf8'),
    readdir: (p, options) => fsp.readdir(p, options),
    writeTempFile,
    putSecretFile,
    resolveNodeRuntime,
    rmrf: (p) => fsp.rm(p, { recursive: true, force: true }),
    move: (src, dst) => fsp.rename(src, dst),
    attachEngines,
    spawnWorker: (...args) => requireWorkerChannel('spawnWorker').spawnWorker(...args),
    engineFor: (...args) => requireWorkerChannel('engineFor').engineFor(...args),
    ownerState: (...args) => requireWorkerChannel('ownerState').ownerState(...args),
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
  createRemoteWorkerChannel,
  createLocalNodeExecutor,
};
