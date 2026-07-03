const childProcess = require('node:child_process');
const path = require('node:path');

const WORKER_OUTPUT_MAX_LINES = 500;
const WORKER_OUTPUT_MAX_BUFFER = 256 * 1024;

/**
 * POSIX single-quote escaping for remote shell insertion. Every string placed
 * into the remote script flows through this function so command, argument,
 * environment value, cwd, and path quoting has one auditable implementation.
 */
function shq(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

function exposedRootsError(message) {
  const err = new Error(message);
  err.code = 'EXPOSED_ROOTS';
  return err;
}

function commandNotAllowedError(command) {
  const err = new Error(`Remote exec command is not allowed: ${command}`);
  err.code = 'COMMAND_NOT_ALLOWED';
  return err;
}

function managerCommandNotAllowedError(command) {
  const err = new Error(`Remote interactive command is not allowed: ${command}`);
  err.code = 'COMMAND_NOT_ALLOWED';
  return err;
}

function envKeyInvalidError(key) {
  const err = new Error(`Invalid remote env key: ${key}`);
  err.code = 'ENV_KEY_INVALID';
  return err;
}

function validateSshDestinationPart(value, field) {
  if (
    typeof value !== 'string'
    || value.length === 0
    || value.startsWith('-')
    || /[\s@]/.test(value)
    || /[\x00-\x1F\x7F]/.test(value)
  ) {
    throw new Error(`${field} is not a safe ssh destination component`);
  }
}

function parseExposedRoots(node) {
  let roots;
  try {
    roots = Array.isArray(node.exposed_roots)
      ? node.exposed_roots
      : JSON.parse(node.exposed_roots || 'null');
  } catch {
    throw exposedRootsError(`SSH node ${node.id || '(unknown)'} has invalid exposed_roots JSON`);
  }
  if (!Array.isArray(roots) || roots.length === 0) {
    throw exposedRootsError(`SSH node ${node.id || '(unknown)'} must declare exposed_roots`);
  }
  for (const root of roots) {
    if (typeof root !== 'string' || !path.posix.isAbsolute(root)) {
      throw exposedRootsError('exposed_roots must contain absolute remote paths');
    }
  }
  return roots;
}

function validateBareFilename(name) {
  if (
    typeof name !== 'string'
    || name.length === 0
    || name !== path.posix.basename(name)
    || name === '.'
    || name === '..'
  ) {
    throw new Error(`writeTempFile: invalid file name "${name}" (must be a bare filename)`);
  }
}

function normalizeMode(mode) {
  if (typeof mode === 'number' && Number.isInteger(mode) && mode >= 0) {
    return mode.toString(8);
  }
  if (typeof mode === 'string' && /^[0-7]{3,4}$/.test(mode)) {
    return mode;
  }
  throw new Error(`writeTempFile: invalid file mode "${mode}"`);
}

function normalizeEnv(env) {
  if (!env) return [];
  return Object.entries(env)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
        throw envKeyInvalidError(key);
      }
      return `${key}=${shq(value === null ? '' : value)}`;
    });
}

function stripOneTrailingNewline(value) {
  return String(value || '').replace(/\n$/, '');
}

function ensureAbsoluteRemotePath(remotePath) {
  if (typeof remotePath !== 'string' || !path.posix.isAbsolute(remotePath)) {
    throw exposedRootsError(`Remote path is outside exposed_roots: ${remotePath}`);
  }
}

function parentFor(remotePath) {
  const stripped = remotePath.length > 1 ? remotePath.replace(/\/+$/, '') : remotePath;
  return path.posix.dirname(stripped || remotePath);
}

function commandError(command, args, res) {
  const message = res.stderr || res.stdout || `${command} ${args.join(' ')} failed with code ${res.code}`;
  const err = new Error(message);
  err.code = res.code;
  err.stdout = res.stdout;
  err.stderr = res.stderr;
  return err;
}

function buildCommandScript(command, args = [], { cwd, env, pathPrefix } = {}) {
  const envParts = normalizeEnv(env);
  const argv = [shq(command), ...(args || []).map((arg) => shq(arg))];
  // Optional PATH prepend for binaries that live outside the pod's minimal
  // non-interactive-ssh PATH (codex/claude under ~/.npm-global/bin). The prefix
  // is shq-quoted (a literal path) but `:$PATH` stays UNQUOTED so the pod's own
  // PATH still resolves (e.g. /usr/bin/node for the codex shebang). Same proven
  // shape as the worker channel's PATH injection.
  const pathAssign = pathPrefix ? `PATH=${shq(pathPrefix)}:$PATH` : null;
  const parts = ['exec'];
  if (pathAssign || envParts.length > 0) {
    parts.push('env');
    if (pathAssign) parts.push(pathAssign);
    parts.push(...envParts);
  }
  parts.push(...argv);
  const script = parts.join(' ');
  return cwd ? `cd ${shq(cwd)} && ${script}` : script;
}

function validateRunId(runId) {
  if (typeof runId !== 'string' || !/^[A-Za-z0-9_-]+$/.test(runId)) {
    throw new Error(`runId is not a safe token: ${runId}`);
  }
  return runId;
}

function normalizeLineLimit(lines) {
  const parsed = Number(lines);
  if (!Number.isFinite(parsed)) return 200;
  return Math.min(Math.max(1, Math.trunc(parsed)), 2000);
}

function normalizeWorkerOutputLineLimit(lines) {
  return Math.min(normalizeLineLimit(lines), WORKER_OUTPUT_MAX_LINES);
}

function lastLines(output, lines = 200) {
  const cappedLines = normalizeLineLimit(lines);
  const text = String(output || '');
  const hadTrailingNewline = text.endsWith('\n');
  const allLines = hadTrailingNewline ? text.slice(0, -1).split('\n') : text.split('\n');
  const selected = allLines.slice(-cappedLines).join('\n');
  return hadTrailingNewline && selected ? `${selected}\n` : selected;
}

function validateWorkerSpec(spec) {
  if (!spec || typeof spec !== 'object') throw new Error('spawnWorker requires a spec object');
  if (typeof spec.command !== 'string' || spec.command.length === 0) {
    throw new Error('spawnWorker requires a non-empty command');
  }
  if (spec.args !== undefined && !Array.isArray(spec.args)) throw new Error('spawnWorker args must be an array');
  if (typeof spec.cwd !== 'string' || spec.cwd.length === 0) {
    throw new Error('spawnWorker requires a cwd');
  }
  if (
    spec.workerPath !== undefined
    && spec.workerPath !== null
    && typeof spec.workerPath !== 'string'
  ) {
    throw new Error('spawnWorker workerPath must be a string when provided');
  }
  if (spec.workerPath !== undefined && spec.workerPath !== null) {
    if (
      spec.workerPath.length === 0
      || !path.posix.isAbsolute(spec.workerPath)
      || /[\x00-\x1F\x7F]/.test(spec.workerPath)
    ) {
      throw new Error('spawnWorker workerPath must be an absolute POSIX path without control characters');
    }
  }
}

/**
 * Create the SSH implementation of the canonical async NodeExecutor API.
 *
 * P2/P3 fleet note: nodeService.pickExecutor can create this executor, but
 * lifecycle run dispatch to the remote worker channel is intentionally wired in
 * P3b, not here. SSH nodes have no heartbeat source yet, so the dispatch gate
 * remains a lifecycle concern.
 *
 * Environment handling intentionally differs from local execFile: process.env
 * is never merged automatically. Only env keys explicitly supplied by the
 * caller are sent to the pod, to avoid leaking controller secrets into remote
 * environments. The remote base env comes from the pod login shell; the
 * controller NEVER forwards process.env. Callers should pass non-secret
 * overrides such as LC_ALL/LANG. Env keys must be shell-identifier-safe.
 *
 * The public exec surface is guarded by an exact command-name allowlist. The
 * default allowlist is ['git']; shell interpreters such as sh, bash, and env
 * are not included and are rejected unless an explicit caller opts into them.
 * This allowlist guards public exec only. Trusted executor-owned filesystem
 * primitives build their own scripts and do not go through the public exec
 * allowlist.
 *
 * Remote worker channel: spawnWorker/ownerOf/isAlive/getOutput/sendInput/
 * detectExitCode/kill are the remote counterpart of executionEngine's tmux
 * worker contract for P3b lifecycle routing through pickExecutor. Status capture is file-based by
 * design: tmux capture-pane can be empty after a detached remote session exits,
 * so stdout and exit status are harvested from per-run files under the first
 * exposed_root. Worker binaries such as codex/claude may live outside the pod
 * login PATH, so callers must pass workerPath when PATH prepending is needed.
 *
 * SSH exit code 255 is treated as transport failure and rejects with
 * err.code='SSH_TRANSPORT'. A remote command that genuinely exits 255 is
 * indistinguishable from ssh(1) transport failure through this transport.
 *
 * Path guard: exposed_roots are canonicalized with remote realpath on first
 * path use. Existing path targets are checked by their own remote realpath so
 * symlink escapes are caught. Creation targets (writeTempFile/mkdir) guard the
 * parent directory because POSIX realpath requires the target to exist, then
 * re-realpath and validate the created target before returning/continuing.
 * Existing-path operations use canonical paths where feasible. The residual
 * realpath-to-operate TOCTOU is accepted for this threat model: pods are
 * operator-controlled, not adversarial mid-operation. rmrf additionally
 * refuses to delete an exposed root itself.
 *
 * Remote requirements: /bin/sh, coreutils-compatible realpath, find, mktemp,
 * chmod, cat, test, mkdir, rm, and tail (getOutput), plus tmux (worker channel
 * spawn/isAlive/kill). readdir implements names only via find and does not
 * support withFileTypes or other readdir options.
 */
function createRemoteSshNodeExecutor(node, {
  spawnFn = childProcess.spawn,
  connectTimeoutMs = 10000,
  commandAllowlist = ['git'],
} = {}) {
  if (!node || node.kind !== 'ssh') {
    throw new Error('createRemoteSshNodeExecutor requires an ssh node row');
  }
  if (!node.ssh_host || !node.ssh_user) {
    throw new Error('SSH node requires ssh_host and ssh_user');
  }
  validateSshDestinationPart(node.ssh_host, 'ssh_host');
  validateSshDestinationPart(node.ssh_user, 'ssh_user');

  const exposedRoots = parseExposedRoots(node);
  const connectTimeoutSeconds = Math.max(1, Math.ceil(Number(connectTimeoutMs || 10000) / 1000));
  const allowedCommands = new Set((commandAllowlist || []).map(String));
  const managerInteractiveCommands = new Set(['codex', 'claude']);
  let canonicalRootsPromise = null;

  function sshArgsFor(script) {
    // ssh JOINS every post-destination arg with spaces and hands the single
    // resulting string to the remote login shell (`$SHELL -c "<joined>"`).
    // Passing `sh`,`-c`,`script` as three separate argv elements therefore
    // becomes `sh -c <script>` on the remote, where `sh -c` captures only the
    // FIRST token of <script> as its program and the rest become $0/$1…
    // Found via the real-pod spike: `exec 'echo' 'ok'` ran as `sh -c exec`
    // (a no-op) → exit 0 with EMPTY stdout, and the exposed_roots realpath
    // guard silently returned empty too (security-critical). Fix: send the
    // whole `sh -c '<script>'` as ONE argument so ssh forwards it intact; the
    // remote login shell runs it via its own -c, and the inner `sh -c` then
    // receives the real script. shq() keeps the single-quoted <script> whole
    // across that one extra shell hop. `--` guards the (already-validated)
    // destination against option-smuggling.
    return [
      '-o', 'BatchMode=yes',
      '-o', `ConnectTimeout=${connectTimeoutSeconds}`,
      '-o', 'StrictHostKeyChecking=accept-new',
      '--',
      `${node.ssh_user}@${node.ssh_host}`,
      `sh -c ${shq(script)}`,
    ];
  }

  function runRemoteScript(script, { timeoutMs, maxBuffer, input } = {}) {
    return new Promise((resolve, reject) => {
      const child = spawnFn('ssh', sshArgsFor(script), { stdio: ['pipe', 'pipe', 'pipe'] });
      const stdoutChunks = [];
      const stderrChunks = [];
      let stdoutBytes = 0;
      let stderrBytes = 0;
      let settled = false;
      let timer = null;

      function bufferedText(which) {
        if (which === 'stdout') return Buffer.concat(stdoutChunks, stdoutBytes).toString('utf8');
        return Buffer.concat(stderrChunks, stderrBytes).toString('utf8');
      }

      function finishReject(err) {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        err.stdout = bufferedText('stdout');
        err.stderr = bufferedText('stderr');
        reject(err);
      }

      function finishResolve(value) {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        resolve(value);
      }

      function appendOutput(which, chunk) {
        if (settled) return;
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
        const currentBytes = which === 'stdout' ? stdoutBytes : stderrBytes;
        const nextBytes = currentBytes + buf.length;
        if (maxBuffer !== undefined && maxBuffer !== null && nextBytes > maxBuffer) {
          const remaining = Math.max(0, Number(maxBuffer) - currentBytes);
          if (which === 'stdout') {
            if (remaining > 0) stdoutChunks.push(buf.subarray(0, remaining));
            stdoutBytes += remaining;
          } else {
            if (remaining > 0) stderrChunks.push(buf.subarray(0, remaining));
            stderrBytes += remaining;
          }
          const err = new Error(`${which} maxBuffer exceeded`);
          err.code = 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER';
          if (typeof child.kill === 'function') child.kill('SIGTERM');
          finishReject(err);
          return;
        }
        if (which === 'stdout') {
          stdoutChunks.push(buf);
          stdoutBytes = nextBytes;
        } else {
          stderrChunks.push(buf);
          stderrBytes = nextBytes;
        }
      }

      if (timeoutMs !== undefined && timeoutMs !== null) {
        timer = setTimeout(() => {
          const err = new Error(`Remote SSH command timed out after ${timeoutMs}ms`);
          err.code = 'ETIMEDOUT';
          err.killed = true;
          err.signal = 'SIGTERM';
          if (typeof child.kill === 'function') child.kill('SIGTERM');
          finishReject(err);
        }, Number(timeoutMs));
      }

      if (child.stdout && typeof child.stdout.on === 'function') {
        child.stdout.on('data', (chunk) => appendOutput('stdout', chunk));
      }
      if (child.stderr && typeof child.stderr.on === 'function') {
        child.stderr.on('data', (chunk) => appendOutput('stderr', chunk));
      }
      child.once('error', (err) => finishReject(err));
      child.once('close', (code, signal) => {
        if (settled) return;
        if (signal) {
          const err = new Error(`Remote SSH command killed by ${signal}`);
          err.killed = true;
          err.signal = signal;
          finishReject(err);
          return;
        }
        if (code === 255) {
          const err = new Error('SSH transport failed');
          err.code = 'SSH_TRANSPORT';
          err.exitCode = 255;
          finishReject(err);
          return;
        }
        finishResolve({
          code: Number(code || 0),
          stdout: bufferedText('stdout'),
          stderr: bufferedText('stderr'),
        });
      });

      if (child.stdin && typeof child.stdin.end === 'function') {
        child.stdin.end(input === undefined ? '' : input);
      }
    });
  }

  function runRemoteCommand(command, args = [], opts = {}) {
    return runRemoteScript(buildCommandScript(command, args, opts), opts);
  }

  async function rawRealpath(remotePath) {
    const res = await runRemoteCommand('realpath', [remotePath]);
    if (res.code !== 0) throw commandError('realpath', [remotePath], res);
    return stripOneTrailingNewline(res.stdout);
  }

  async function canonicalRoots() {
    if (!canonicalRootsPromise) {
      canonicalRootsPromise = (async () => {
        const roots = [];
        for (const root of exposedRoots) {
          roots.push(await rawRealpath(root));
        }
        return roots;
      })();
    }
    return canonicalRootsPromise;
  }

  function isWithinRoot(canonicalPath, canonicalRoot) {
    if (canonicalRoot === '/') return path.posix.isAbsolute(canonicalPath);
    return canonicalPath === canonicalRoot || canonicalPath.startsWith(`${canonicalRoot}/`);
  }

  async function assertCanonicalWithinRoots(canonicalPath, originalPath) {
    const roots = await canonicalRoots();
    if (!roots.some((root) => isWithinRoot(canonicalPath, root))) {
      throw exposedRootsError(`Remote path is outside exposed_roots: ${originalPath}`);
    }
    return canonicalPath;
  }

  async function assertWithinRoots(remotePath, { allowMissing = false, parentOnly = false } = {}) {
    ensureAbsoluteRemotePath(remotePath);
    if (parentOnly) {
      const parentCanonical = await rawRealpath(parentFor(remotePath));
      await assertCanonicalWithinRoots(parentCanonical, remotePath);
      return { canonical: parentCanonical, exists: false };
    }

    try {
      const canonical = await rawRealpath(remotePath);
      await assertCanonicalWithinRoots(canonical, remotePath);
      return { canonical, exists: true };
    } catch (err) {
      if (err.code === 'SSH_TRANSPORT' || err.code === 'EXPOSED_ROOTS') throw err;
      if (allowMissing) {
        let ancestor = parentFor(remotePath);
        while (true) {
          try {
            const ancestorCanonical = await rawRealpath(ancestor);
            await assertCanonicalWithinRoots(ancestorCanonical, remotePath);
            return { canonical: null, exists: false };
          } catch (parentErr) {
            if (parentErr.code === 'SSH_TRANSPORT' || parentErr.code === 'EXPOSED_ROOTS') throw parentErr;
            const next = parentFor(ancestor);
            if (next === ancestor) throw parentErr;
            ancestor = next;
          }
        }
      }
      throw err;
    }
  }

  async function cleanupCreatedPath(remotePath) {
    if (typeof remotePath !== 'string' || !path.posix.isAbsolute(remotePath)) return;
    try {
      await runRemoteCommand('rm', ['-rf', remotePath]);
    } catch {
      // Best-effort cleanup only; preserve the root-guard failure.
    }
  }

  async function exec(command, args = [], { cwd, env, timeoutMs, maxBuffer } = {}) {
    if (!allowedCommands.has(String(command))) throw commandNotAllowedError(command);
    let safeCwd = cwd;
    if (cwd) safeCwd = (await assertWithinRoots(cwd)).canonical;
    return runRemoteCommand(command, args, { cwd: safeCwd, env, timeoutMs, maxBuffer });
  }

  async function spawnInteractive(command, args = [], { cwd, env, pathPrefix } = {}) {
    const commandName = String(command);
    if (!managerInteractiveCommands.has(commandName)) throw managerCommandNotAllowedError(command);
    // PATH-trust guard: a relative/control-char pathPrefix ('.', 'relative/bin')
    // would let the remote cwd/project supply a fake codex/claude on PATH,
    // defeating the manager-command allowlist. Require an absolute POSIX path
    // without control chars — same contract as the worker channel's workerPath.
    // (Codex P4-S1 review.)
    if (pathPrefix !== undefined && pathPrefix !== null) {
      if (
        typeof pathPrefix !== 'string'
        || pathPrefix.length === 0
        || !path.posix.isAbsolute(pathPrefix)
        || /[\x00-\x1F\x7F]/.test(pathPrefix)
      ) {
        throw new Error('spawnInteractive pathPrefix must be an absolute POSIX path without control characters');
      }
    }
    let safeCwd = cwd;
    if (cwd) safeCwd = (await assertWithinRoots(cwd)).canonical;
    const script = buildCommandScript(commandName, args, { cwd: safeCwd, env, pathPrefix });
    return spawnFn('ssh', sshArgsFor(script), { stdio: ['pipe', 'pipe', 'pipe'] });
  }

  async function fileExists(remotePath) {
    const checked = await assertWithinRoots(remotePath, { allowMissing: true });
    if (!checked.exists) return false;
    const res = await runRemoteCommand('test', ['-e', checked.canonical]);
    if (res.code === 0) return true;
    if (res.code === 1) return false;
    throw commandError('test', ['-e', remotePath], res);
  }

  async function realpath(remotePath) {
    const checked = await assertWithinRoots(remotePath);
    return checked.canonical;
  }

  async function readFile(remotePath) {
    const checked = await assertWithinRoots(remotePath);
    const res = await runRemoteCommand('cat', [checked.canonical]);
    if (res.code !== 0) throw commandError('cat', [checked.canonical], res);
    return res.stdout;
  }

  async function writeTempFile(prefix, name, content, mode = 0o600) {
    validateBareFilename(name);
    ensureAbsoluteRemotePath(prefix);
    await assertWithinRoots(prefix, { parentOnly: true });
    const modeString = normalizeMode(mode);
    const template = `${prefix}XXXXXX`;
    const script = [
      `tmpdir=$(mktemp -d ${shq(template)})`,
      `cat > "$tmpdir"/${shq(name)}`,
      `chmod ${shq(modeString)} "$tmpdir"/${shq(name)}`,
      `printf '%s\\n' "$tmpdir"/${shq(name)}`,
    ].join(' && ');
    const res = await runRemoteScript(script, { input: content });
    if (res.code !== 0) throw commandError('writeTempFile', [prefix, name], res);
    const createdPath = stripOneTrailingNewline(res.stdout);
    try {
      await assertWithinRoots(createdPath);
    } catch (err) {
      await cleanupCreatedPath(path.posix.dirname(createdPath));
      throw err;
    }
    return createdPath;
  }

  async function putSecretFile(name, content, mode = 0o600) {
    validateBareFilename(name);
    const prefix = path.posix.join(exposedRoots[0], '.palantir-secret-');
    return writeTempFile(prefix, name, content, mode);
  }

  async function readdir(remotePath, options) {
    if (options !== undefined && options !== null) {
      throw new Error('RemoteSshNodeExecutor.readdir does not support options such as withFileTypes');
    }
    const checked = await assertWithinRoots(remotePath);
    const res = await runRemoteCommand('find', [checked.canonical, '-mindepth', '1', '-maxdepth', '1', '-print']);
    if (res.code !== 0) throw commandError('find', [checked.canonical], res);
    return res.stdout.split('\n').filter(Boolean).map((entry) => path.posix.basename(entry));
  }

  async function stat(remotePath) {
    const checked = await assertWithinRoots(remotePath);
    const dirRes = await runRemoteCommand('test', ['-d', checked.canonical]);
    if (dirRes.code !== 0 && dirRes.code !== 1) throw commandError('test', ['-d', checked.canonical], dirRes);
    const fileRes = await runRemoteCommand('test', ['-f', checked.canonical]);
    if (fileRes.code !== 0 && fileRes.code !== 1) throw commandError('test', ['-f', checked.canonical], fileRes);
    const isDirectory = dirRes.code === 0;
    const isFile = fileRes.code === 0;
    return {
      isDirectory: () => isDirectory,
      isFile: () => isFile,
    };
  }

  async function mkdir(remotePath, options = {}) {
    await assertWithinRoots(remotePath, { parentOnly: true });
    const args = options && options.recursive ? ['-p', remotePath] : [remotePath];
    const res = await runRemoteCommand('mkdir', args);
    if (res.code !== 0) throw commandError('mkdir', args, res);
    try {
      await assertWithinRoots(remotePath);
    } catch (err) {
      await cleanupCreatedPath(remotePath);
      throw err;
    }
  }

  async function rmrf(remotePath) {
    const checked = await assertWithinRoots(remotePath);
    const roots = await canonicalRoots();
    if (roots.some((root) => checked.canonical === root)) {
      throw exposedRootsError(`Refusing to remove exposed root: ${remotePath}`);
    }
    const res = await runRemoteCommand('rm', ['-rf', checked.canonical]);
    if (res.code !== 0) throw commandError('rm', ['-rf', checked.canonical], res);
  }

  function workerPaths(runId) {
    const safeRunId = validateRunId(runId);
    const firstRoot = exposedRoots[0].replace(/\/+$/, '') || '/';
    const runsRoot = path.posix.join(firstRoot, '.palantir-runs');
    const statusDir = path.posix.join(runsRoot, safeRunId);
    return {
      safeRunId,
      sessionName: `palantir-run-${safeRunId}`,
      runsRoot,
      statusDir,
      stdoutLog: path.posix.join(statusDir, 'stdout.log'),
      exitSentinel: path.posix.join(statusDir, 'exit.code'),
    };
  }

  function buildWorkerInvocation({ command, args = [], env, workerPath }) {
    const envParts = normalizeEnv(env);
    const list = Array.isArray(args) ? args : [];
    const argv = [shq(command), ...list.map((arg) => shq(arg))];
    const invocation = ['env', ...envParts, ...argv].join(' ');
    return workerPath ? `PATH=${shq(workerPath)}:$PATH ${invocation}` : invocation;
  }

  async function ensureWorkerStatusDir(paths) {
    await mkdir(paths.runsRoot, { recursive: true });
    await mkdir(paths.statusDir, { recursive: true });
  }

  function resolveWorkerSpec(workerRequest) {
    if (
      workerRequest
      && typeof workerRequest === 'object'
      && Object.prototype.hasOwnProperty.call(workerRequest, 'engine')
    ) {
      if (workerRequest.engine !== 'cli') {
        throw new Error('remote nodes cannot run stream-json/claude workers yet — P5');
      }
      return workerRequest.spec;
    }
    return workerRequest;
  }

  async function spawnWorker(runId, workerRequest) {
    const spec = resolveWorkerSpec(workerRequest);
    validateWorkerSpec(spec);
    const paths = workerPaths(runId);
    const safeCwd = (await assertWithinRoots(spec.cwd)).canonical;
    await ensureWorkerStatusDir(paths);

    const workerInvocation = buildWorkerInvocation(spec);
    const innerScript = `${workerInvocation} > ${shq(paths.stdoutLog)} 2>&1; echo $? > ${shq(paths.exitSentinel)}`;
    const script = `cd ${shq(safeCwd)} && tmux new-session -d -s ${shq(paths.sessionName)} ${shq(innerScript)}`;
    const res = await runRemoteScript(script);
    if (res.code !== 0) {
      throw commandError('tmux', ['new-session', '-d', '-s', paths.sessionName], res);
    }
    return { sessionName: paths.sessionName };
  }

  async function ownerOf(runId) {
    return (await isAlive(runId)) ? 'cli' : null;
  }

  async function isAlive(runId, _engine) {
    const paths = workerPaths(runId);
    const res = await runRemoteCommand('tmux', ['has-session', '-t', paths.sessionName]);
    return res.code === 0;
  }

  async function getOutput(runId, lines = 200, _engine) {
    const paths = workerPaths(runId);
    const cappedLines = normalizeWorkerOutputLineLimit(lines);
    try {
      const checked = await assertWithinRoots(paths.stdoutLog, { allowMissing: true });
      const tailPath = checked.exists ? checked.canonical : paths.stdoutLog;
      const res = await runRemoteCommand('tail', ['-n', String(cappedLines), tailPath], {
        maxBuffer: WORKER_OUTPUT_MAX_BUFFER,
      });
      if (res.code !== 0) return '';
      return res.stdout;
    } catch (err) {
      if (err.code === 'SSH_TRANSPORT' || err.code === 'EXPOSED_ROOTS') throw err;
      return '';
    }
  }

  async function sendInput(_runId, _text) {
    // Interactive remote input is deferred to P5; P3b codex workers are non-interactive.
    return false;
  }

  async function detectExitCode(runId, _engine) {
    const paths = workerPaths(runId);
    let text;
    try {
      text = await readFile(paths.exitSentinel);
    } catch (err) {
      if (err.code === 'SSH_TRANSPORT' || err.code === 'EXPOSED_ROOTS') throw err;
      return null;
    }
    const trimmed = String(text || '').trim();
    if (!trimmed) return null;
    if (!/^\d+$/.test(trimmed)) return null;
    const code = Number.parseInt(trimmed, 10);
    return code >= 0 && code <= 255 ? code : null;
  }

  async function kill(runId, _engine) {
    const paths = workerPaths(runId);
    const res = await runRemoteCommand('tmux', ['kill-session', '-t', paths.sessionName]);
    return res.code === 0;
  }

  async function cleanupRun(runId) {
    const paths = workerPaths(runId);
    await rmrf(paths.statusDir);
  }

  return {
    exec,
    spawnInteractive,
    spawnWorker,
    ownerOf,
    isAlive,
    detectExitCode,
    getOutput,
    sendInput,
    kill,
    cleanupRun,
    fileExists,
    realpath,
    stat,
    mkdir,
    readFile,
    readdir,
    writeTempFile,
    putSecretFile,
    rmrf,
    assertWithinRoots: async (remotePath) => (await assertWithinRoots(remotePath)).canonical,
  };
}

module.exports = {
  createRemoteSshNodeExecutor,
  shq,
};
