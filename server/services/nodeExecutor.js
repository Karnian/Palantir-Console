const childProcess = require('node:child_process');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

/**
 * NodeExecutor is the transport-neutral seam between the control plane and a
 * future execution node. The full contract from the fleet brief is:
 *
 * - exec(command, args, { cwd, env, timeoutMs }) -> { code, stdout, stderr }
 * - spawnInteractive(command, args, opts) plus getOutput/sendInput/kill/detectExitCode
 * - liveness(runId) -> 'alive' | 'dead' | 'unreachable'
 * - listSessions() / discoverGhostSessions()
 * - realpath / fileExists / readFile / writeTempFile / readdir / rmrf
 * - putSecretFile(path, content, mode = 0o600) with cleanup hooks
 *
 * P0a implements the local async exec and file APIs plus a local-only sync
 * compatibility bridge for existing file/git call sites. It intentionally does
 * not provide throwing placeholders for spawnInteractive, liveness, session
 * discovery, or putSecretFile; those methods are added in later phases.
 */
function createLocalNodeExecutor() {
  /**
   * Run a command to completion. Resolves { code, stdout, stderr } only for
   * genuine process exits (including nonzero codes). Rejects for operational
   * failures — spawn errors (ENOENT), timeout/signal kills, maxBuffer
   * overflow — with partial stdout/stderr attached to the error so callers
   * that can salvage output (e.g. truncated diffs) may do so. Collapsing
   * operational failures into a fake exit code would make "command failed"
   * indistinguishable from "transport/limit failed" once executors go remote.
   */
  function exec(command, args = [], { cwd, env, timeoutMs } = {}) {
    return new Promise((resolve, reject) => {
      childProcess.execFile(
        command,
        args,
        {
          cwd,
          env,
          timeout: timeoutMs,
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

  return {
    exec,
    fileExists,
    realpath: (p) => fsp.realpath(p),
    readFile: (p) => fsp.readFile(p, 'utf8'),
    readdir: (p, options) => fsp.readdir(p, options),
    writeTempFile,
    rmrf: (p) => fsp.rm(p, { recursive: true, force: true }),

    /**
     * Local-only compat bridge; remote executors will NOT implement these - the
     * async API is canonical and call sites migrate in P0b.
     */
    execFileSync: (command, args, opts) => childProcess.execFileSync(command, args, opts),
    existsSync: (p) => fs.existsSync(p),
    realpathSync: (p) => fs.realpathSync(p),
    statSync: (p, options) => fs.statSync(p, options),
    mkdirSync: (p, options) => fs.mkdirSync(p, options),
    rmSync: (p, options) => fs.rmSync(p, options),
  };
}

module.exports = {
  createLocalNodeExecutor,
};
