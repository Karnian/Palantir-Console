const childProcess = require('node:child_process');
const path = require('node:path');
const {
  WRAPPER_BOOT_ENV_KEYS: WRAPPER_NODE_BOOT_ENV_KEYS,
} = require('./managerAdapters/codexMcpSecretTransport');

const WORKER_OUTPUT_MAX_LINES = 500;
const WORKER_OUTPUT_MAX_BUFFER = 256 * 1024;
const SSH_SERVER_ALIVE_INTERVAL_SECONDS = 15;
const SSH_SERVER_ALIVE_COUNT_MAX = 4;

// Fixed pod-side probe for the claude OAuth usage endpoint (node-usage v2,
// brief §5-1). Security contract (Codex security review R1 applied):
//   * The script is a CONSTANT — no caller input is ever interpolated.
//   * The pod's ~/.claude/.credentials.json is read INSIDE a single node
//     process which also performs the HTTPS call itself — the token never
//     appears in any argv (curl removed entirely: a pod-local ~/.curlrc such
//     as `trace-ascii = -` could otherwise echo the Authorization header back
//     across SSH — R1 BLOCKER). Only the usage-report JSON body (HTTP 200)
//     crosses the transport back.
//   * Exit codes: 3 = no readable token (paired with __NO_CLAUDE_TOKEN__ on
//     stdout), 5 = HTTP non-200 (status-only sentinel, body deliberately
//     dropped), 6 = oversized response, 7 = network/timeout. Callers must
//     match code AND sentinel, not code alone.
//   * PATH-resolved `node` is trusted per the fleet threat model (pods are
//     operator-controlled — same trust as every other executor script that
//     resolves sh/realpath/tmux from the pod PATH).
const CLAUDE_OAUTH_USAGE_JS = [
  'const https=require("https");const os=require("os");',
  'let tok="";try{const c=require(os.homedir()+"/.claude/.credentials.json");tok=(c.claudeAiOauth&&c.claudeAiOauth.accessToken)||""}catch(e){}',
  'if(!tok){process.stdout.write("__NO_CLAUDE_TOKEN__");process.exit(3)}',
  'const req=https.request({host:"api.anthropic.com",path:"/api/oauth/usage",method:"GET",headers:{Authorization:"Bearer "+tok,"anthropic-beta":"oauth-2025-04-20",Accept:"application/json"},timeout:8000},(res)=>{',
  'let b="";res.on("data",(d)=>{b+=d;if(b.length>262144){process.exit(6)}});',
  'res.on("end",()=>{if(res.statusCode!==200){process.stdout.write("__CLAUDE_USAGE_HTTP_"+res.statusCode+"__");process.exit(5)}process.stdout.write(b);process.exit(0)});',
  '});',
  'req.on("timeout",()=>{req.destroy();process.exit(7)});req.on("error",()=>process.exit(7));req.end();',
].join('');
const CLAUDE_OAUTH_USAGE_SCRIPT = `exec node -e '${CLAUDE_OAUTH_USAGE_JS.replace(/'/g, "'\\''")}'`;

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

function basenameFor(remotePath) {
  const stripped = remotePath.length > 1 ? remotePath.replace(/\/+$/, '') : remotePath;
  return path.posix.basename(stripped);
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

  function sshArgsFor(script, { keepAlive } = {}) {
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
      ...(keepAlive ? [
        '-o', `ServerAliveInterval=${SSH_SERVER_ALIVE_INTERVAL_SECONDS}`,
        '-o', `ServerAliveCountMax=${SSH_SERVER_ALIVE_COUNT_MAX}`,
      ] : []),
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
        const immediateParent = parentFor(remotePath);
        try {
          const parentCanonical = await rawRealpath(immediateParent);
          await assertCanonicalWithinRoots(parentCanonical, remotePath);
          return {
            canonical: path.posix.join(parentCanonical, basenameFor(remotePath)),
            parentCanonical,
            exists: false,
          };
        } catch (parentErr) {
          if (parentErr.code === 'SSH_TRANSPORT' || parentErr.code === 'EXPOSED_ROOTS') throw parentErr;
        }
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
    return spawnFn('ssh', sshArgsFor(script, { keepAlive: true }), { stdio: ['pipe', 'pipe', 'pipe'] });
  }

  /**
   * Executor-owned claude quota probe (node-usage v2). Runs the FIXED
   * CLAUDE_OAUTH_USAGE_SCRIPT on the pod — see the constant's security
   * contract. Resolves with { code, stdout, stderr } like runRemoteScript;
   * SSH transport failure rejects with code='SSH_TRANSPORT'.
   */
  async function readClaudeOAuthUsage({ timeoutMs = 15000, maxBuffer = 256 * 1024, pathPrefix } = {}) {
    let script = CLAUDE_OAUTH_USAGE_SCRIPT;
    if (pathPrefix !== undefined && pathPrefix !== null) {
      // node_prefix may be a single dir or a `:`-joined list (multiple CLIs
      // installed in different places). path.posix.isAbsolute() only checks
      // the FIRST character of the whole string, so '/opt/bin:relative/bin'
      // would otherwise pass — a relative segment there resolves against the
      // remote CWD at exec time, letting anything writable to that directory
      // supply the `node` binary this script runs (and thus see the pod's
      // Claude OAuth token). Every colon-separated segment must be absolute
      // (Codex adversarial review catch).
      const segments = typeof pathPrefix === 'string' ? pathPrefix.split(':') : null;
      const segmentsValid = Array.isArray(segments)
        && segments.length > 0
        && segments.every((segment) => segment.length > 0 && path.posix.isAbsolute(segment));
      if (
        typeof pathPrefix !== 'string'
        || pathPrefix.length === 0
        || !segmentsValid
        || /[\x00-\x1F\x7F]/.test(pathPrefix)
      ) {
        throw new Error('readClaudeOAuthUsage pathPrefix must be one or more absolute POSIX paths (colon-separated) without control characters');
      }
      // Same PATH-prepend shape as buildCommandScript — the pod's `node`
      // often lives outside the minimal non-interactive-ssh PATH (Homebrew/
      // nvm/npm-global installs never get sourced by a bare `ssh host cmd`).
      // CLAUDE_OAUTH_USAGE_JS itself is untouched (constant, security-
      // hardened per the module comment above) — only the outer `exec`
      // wrapper gains an `env PATH=...` prefix, exactly like
      // buildCommandScript does for every other remote command.
      script = script.replace(/^exec /, `exec env PATH=${shq(pathPrefix)}:$PATH `);
    }
    return runRemoteScript(script, { timeoutMs, maxBuffer });
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
      `tmpdir=''`,
      `cleanup() { if [ -n "$tmpdir" ]; then rm -rf -- "$tmpdir"; fi; }`,
      `trap 'rc=$?; cleanup; exit "$rc"' 0`,
      `trap 'exit 129' HUP`,
      `trap 'exit 130' INT`,
      `trap 'exit 143' TERM`,
      `tmpdir=$(mktemp -d ${shq(template)})`,
      `cat > "$tmpdir"/${shq(name)}`,
      `chmod ${shq(modeString)} "$tmpdir"/${shq(name)}`,
      `printf '%s\\n' "$tmpdir"/${shq(name)}`,
      `trap - 0 HUP INT TERM`,
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

  async function resolveNodeRuntime({ pathPrefix = node.node_prefix || undefined } = {}) {
    if (pathPrefix !== undefined && pathPrefix !== null) {
      if (
        typeof pathPrefix !== 'string'
        || pathPrefix.length === 0
        || !path.posix.isAbsolute(pathPrefix)
        || /[\x00-\x1F\x7F]/.test(pathPrefix)
      ) {
        throw new Error(
          'resolveNodeRuntime pathPrefix must be an absolute POSIX path without control characters',
        );
      }
    }
    const lookup = pathPrefix
      ? `PATH=${shq(pathPrefix)}:$PATH command -v node`
      : 'command -v node';
    const cleanBootEnv = WRAPPER_NODE_BOOT_ENV_KEYS
      .map(key => `${key}=''`)
      .join(' ');
    const script = [
      `candidate=$(${lookup})`,
      `candidate=$(realpath "$candidate")`,
      `case "$candidate" in /*) ;; *) exit 126 ;; esac`,
      `[ -x "$candidate" ]`,
      `${cleanBootEnv} "$candidate" -e ${shq('require("node:child_process");require("node:os").constants.signals;')}`,
      `printf '%s\\n' "$candidate"`,
    ].join(' && ');
    const res = await runRemoteScript(script, { timeoutMs: 10000, maxBuffer: 4096 });
    if (res.code !== 0) {
      const err = new Error(
        'Codex MCP stdio env transport requires a working Node.js runtime on the execution node',
      );
      err.code = 'MCP_WRAPPER_RUNTIME_UNAVAILABLE';
      throw err;
    }
    const resolved = stripOneTrailingNewline(res.stdout);
    if (
      !path.posix.isAbsolute(resolved)
      || /[\x00-\x1F\x7F]/.test(resolved)
      || path.posix.normalize(resolved) !== resolved
    ) {
      throw new Error('Remote Node.js runtime resolved to an unsafe path');
    }
    return resolved;
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

  // G2b §5k-1: ensure a path is a REAL directory (mkdir -p + no-follow validation).
  // `test -L` on the LITERAL path rejects a symlink where a real dir must be (a
  // reused-node swap); `test -d` requires a directory. assertWithinRoots already
  // rejects a realpath that escapes exposed_roots. Adversarial concurrent
  // node-local symlink swaps are OUT of scope (an operator-trusted node — a
  // compromised node is already game-over under the executor trust boundary).
  async function ensureRealDir(remotePath) {
    await mkdir(remotePath, { recursive: true });
    const lit = shq(remotePath);
    const res = await runRemoteScript(`if test -L ${lit}; then echo symlink; elif test -d ${lit}; then echo dir; else echo other; fi`);
    if (res.code !== 0) throw commandError('ensureRealDir', [remotePath], res);
    const kind = stripOneTrailingNewline(res.stdout);
    if (kind !== 'dir') throw exposedRootsError(`Remote path is a ${kind}, not a real directory: ${remotePath}`);
    return remotePath;
  }

  // G2b §5k-1: bounded enumerate with sizes for the remote deliverable harvest.
  // NUL-delimited records (a filename can't forge a record); the WALK is bounded
  // by entry count via `head -z -n MAX+1` (head closes the pipe → find stops).
  // Regular files only (%y=='f' excludes symlinks/dirs); relPaths that are
  // absolute / empty / contain a '..' segment are rejected.
  async function listFilesWithSizes(root, { maxEntries = 5000 } = {}) {
    const checked = await assertWithinRoots(root);
    const cap = Math.max(1, Number(maxEntries) || 5000);
    const r = shq(checked.canonical);
    // dash has no `pipefail`, so `find | head` returns head's status (0) even when
    // find fails — masking a partial walk (codex BLOCKER). Append a `FINDEXIT:<code>`
    // marker AFTER find in the same group: if head SIGPIPEs the walk on truncation,
    // find (and the marker printf) die → NO marker → truncated. If find completes,
    // the marker carries its exit; a NONZERO find exit → reject (partial enumerate).
    const script = `{ find ${r} -mindepth 1 -printf '%y\\t%s\\t%P\\0' 2>/dev/null; printf 'FINDEXIT:%s\\0' "$?"; } | head -z -n ${cap + 2}`;
    const res = await runRemoteScript(script, { maxBuffer: 8 * 1024 * 1024, timeoutMs: 60000 });
    if (res.code !== 0 && !res.stdout) throw commandError('listFilesWithSizes', [checked.canonical], res);
    const allRecords = String(res.stdout).split('\0').filter((s) => s.length > 0);
    // Extract the terminal FINDEXIT marker (present iff find ran to completion).
    let findComplete = false;
    if (allRecords.length && allRecords[allRecords.length - 1].startsWith('FINDEXIT:')) {
      const code = Number(allRecords.pop().slice('FINDEXIT:'.length));
      if (Number.isFinite(code) && code !== 0) {
        throw commandError('listFilesWithSizes', [checked.canonical], { code, stdout: '', stderr: 'find exited nonzero' });
      }
      findComplete = true;
    }
    const records = allRecords;
    const truncated = !findComplete || records.length > cap; // no marker ⇒ walk truncated
    const files = [];
    for (const rec of records.slice(0, cap)) {
      const t1 = rec.indexOf('\t');
      const t2 = rec.indexOf('\t', t1 + 1);
      if (t1 < 0 || t2 < 0) continue;
      const type = rec.slice(0, t1);
      const size = Number(rec.slice(t1 + 1, t2));
      const relPath = rec.slice(t2 + 1);
      if (type !== 'f') continue; // regular files only
      if (!relPath || relPath.startsWith('/') || relPath.split('/').includes('..')) continue;
      if (!Number.isFinite(size) || size < 0) continue;
      files.push({ relPath, size });
    }
    return { files, truncated };
  }

  // G2b §5k-1: capped, binary-safe remote read. `head -c cap | base64 -w0` →
  // exact first `maxBytes` bytes (never a full-file slurp; base64 avoids UTF-8
  // corruption). Re-guards exposed_roots at READ time (listing→read swap window).
  async function readFileCapped(remotePath, maxBytes) {
    const checked = await assertWithinRoots(remotePath);
    const cap = Math.max(0, Math.floor(Number(maxBytes) || 0));
    const p = shq(checked.canonical);
    // dash has no pipefail, so `head | base64` masks a head failure (missing/
    // unreadable file) as empty base64 → empty bytes (codex BLOCKER). Capture
    // head's status by writing to a node-local temp FIRST; base64 only on success,
    // else exit nonzero so the caller throws (→ no false-empty bundle).
    const script = `t=$(mktemp) || exit 3; if head -c ${cap} ${p} > "$t" 2>/dev/null; then if base64 -w0 "$t"; then rc=0; else rc=5; fi; else rc=4; fi; rm -f "$t"; exit $rc`;
    const b64Max = 4 * Math.ceil((cap + 2) / 3) + 64;
    const res = await runRemoteScript(script, { maxBuffer: b64Max, timeoutMs: 60000 });
    if (res.code !== 0) throw commandError('readFileCapped', [checked.canonical], res);
    return Buffer.from(String(res.stdout).trim(), 'base64');
  }

  async function rmrf(remotePath) {
    const checked = await assertWithinRoots(remotePath, { allowMissing: true });
    if (!checked.exists) return;
    const roots = await canonicalRoots();
    if (roots.some((root) => checked.canonical === root)) {
      throw exposedRootsError(`Refusing to remove exposed root: ${remotePath}`);
    }
    const res = await runRemoteCommand('rm', ['-rf', checked.canonical]);
    if (res.code !== 0) throw commandError('rm', ['-rf', checked.canonical], res);
  }

  async function move(src, dst) {
    const checkedSrc = await assertWithinRoots(src);
    const checkedDst = await assertWithinRoots(dst, { allowMissing: true });
    if (!checkedDst.canonical) {
      throw exposedRootsError(`Remote destination parent is outside exposed_roots: ${dst}`);
    }
    const target = checkedDst.canonical;
    const res = await runRemoteCommand('mv', [checkedSrc.canonical, target]);
    if (res.code !== 0) throw commandError('mv', [checkedSrc.canonical, target], res);
    await assertWithinRoots(dst);
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
    readClaudeOAuthUsage,
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
    ensureRealDir,
    listFilesWithSizes,
    readFileCapped,
    readFile,
    readdir,
    writeTempFile,
    putSecretFile,
    resolveNodeRuntime,
    rmrf,
    move,
    assertWithinRoots: async (remotePath, options = {}) => (await assertWithinRoots(remotePath, options)).canonical,
  };
}

module.exports = {
  createRemoteSshNodeExecutor,
  shq,
};
