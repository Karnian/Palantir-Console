const childProcess = require('node:child_process');
const path = require('node:path');
const {
  WRAPPER_BOOT_ENV_KEYS: WRAPPER_NODE_BOOT_ENV_KEYS,
} = require('./managerAdapters/codexMcpSecretTransport');
const {
  WORKER_BASE_ENV_KEYS,
  MANAGER_BASE_ENV_KEYS,
  isActorCredentialKey,
  normalizeWorkerApiBase,
} = require('./actorTokenPolicy');

const WORKER_OUTPUT_MAX_LINES = 500;
const WORKER_OUTPUT_MAX_BUFFER = 256 * 1024;
// A Claude result event repeats the full final answer in one JSONL record, so
// it can legitimately exceed the small live-tail ceiling. Keep this separately
// bounded at 4 MiB: large enough for Claude's practical output window while
// still preventing an untrusted remote file from growing controller memory
// without limit.
const CLAUDE_RESULT_MAX_BUFFER = 4 * 1024 * 1024;
const SSH_SERVER_ALIVE_INTERVAL_SECONDS = 15;
const SSH_SERVER_ALIVE_COUNT_MAX = 4;
// Errors that can be observed after bytes have crossed the SSH stdin/channel
// boundary. A detached tmux start may already own the run when any of these is
// reported, so retry is unsafe until ownership probes prove otherwise.
const DETACHED_START_TRANSPORT_ERROR_CODES = new Set([
  'SSH_TRANSPORT',
  'EPIPE',
  'ECONNRESET',
  'ECONNABORTED',
  'ETIMEDOUT',
  'ERR_STREAM_DESTROYED',
  'EOF',
]);
// Executor-owned filesystem probes need stable diagnostics for reason mapping.
// Never apply this to public exec, worker, or manager command output.
const FILESYSTEM_LOCALE_ENV = Object.freeze({ LC_ALL: 'C' });
// Absolute path: under `env -i` there is no PATH yet when the shell itself is
// resolved, so a bare `sh` would not be found.
const SH_BIN = '/bin/sh';
// Remote agents inherit their runtime baseline from the pod login shell, not
// from the Console process. Filter the shared policy to POSIX-relevant names;
// Windows-only locator/runtime keys have no meaning in Linux pods and are
// deliberately omitted. Manager-only network/vendor additions are still read
// from MANAGER_BASE_ENV_KEYS below so the local and remote policy lists cannot
// drift.
const REMOTE_POD_PROCESS_ENV_KEYS = new Set([
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'SHELL',
  'LANG',
  'LANGUAGE',
  'LC_ALL',
  'LC_CTYPE',
  'TERM',
  'COLORTERM',
  'NO_COLOR',
  'FORCE_COLOR',
  'TMPDIR',
  'TEMP',
  'TMP',
]);
const REMOTE_WORKER_BASE_ENV_KEYS = Object.freeze(
  WORKER_BASE_ENV_KEYS.filter((key) => REMOTE_POD_PROCESS_ENV_KEYS.has(key)),
);

// Fixed pod-side probe for the claude OAuth usage endpoint (node-usage v2,
// brief §5-1). Security contract (Codex security review R1 applied):
//   * The script is a CONSTANT — no caller input is ever interpolated.
//   * The pod's ~/.claude/.credentials.json is read INSIDE a single node
//     process which also performs the HTTPS call itself — the token never
//     appears in any argv (curl removed entirely: a pod-local ~/.curlrc such
//     as `trace-ascii = -` could otherwise echo the Authorization header back
//     across SSH — R1 BLOCKER). Only the usage-report JSON body (HTTP 200)
//     crosses the transport back.
//   * An expired access token is REPORTED, never refreshed. Refreshing would
//     mean rewriting the CLI's own credential file on the pod, and if the
//     grant rotates the refresh token, discarding the new one revokes the
//     user's login — on every poll of an idle node. Recovery is running Claude
//     once on that node. A supported refresh path is tracked separately (#437).
//   * Exit codes: 3 = no readable token (paired with __NO_CLAUDE_TOKEN__ on
//     stdout), 4 = the access token is expired (paired with
//     __CLAUDE_TOKEN_EXPIRED__; reported locally, no request is made),
//     5 = HTTP non-200 (status-only sentinel, body deliberately dropped),
//     6 = oversized response, 7 = network/timeout. Callers must match codes
//     with sentinels where one is defined, not codes alone.
//   * PATH-resolved `node` is trusted per the fleet threat model (pods are
//     operator-controlled — same trust as every other executor script that
//     resolves sh/realpath/tmux from the pod PATH).
const CLAUDE_OAUTH_USAGE_JS = [
  'const https=require("https");const os=require("os");',
  'let oauth={};try{const c=require(os.homedir()+"/.claude/.credentials.json");oauth=(c&&c.claudeAiOauth)||{}}catch(e){}',
  'let finished=false;function finish(code,out){if(finished)return;finished=true;if(out)process.stdout.write(out);process.exit(code)}',
  'const tok=typeof oauth.accessToken==="string"?oauth.accessToken:"";',
  'if(!tok){finish(3,"__NO_CLAUDE_TOKEN__")}else{',
  // An expired access token is reported WITHOUT calling the API. Refreshing it
  // here would mean writing the CLI's own credential file back on the pod, and
  // if the grant rotates the refresh token, dropping the new one would revoke
  // the user's CLI login on every idle-node poll. Detect and report; recovery
  // is "run Claude once on that node". See #437.
  'const exp=Number(oauth.expiresAt);if(Number.isFinite(exp)&&Date.now()>=exp){finish(4,"__CLAUDE_TOKEN_EXPIRED__")}else{',
  'const req=https.request({host:"api.anthropic.com",path:"/api/oauth/usage",method:"GET",headers:{Authorization:"Bearer "+tok,"anthropic-beta":"oauth-2025-04-20",Accept:"application/json"},timeout:8000},(res)=>{',
  'let b="";res.on("data",(d)=>{if(finished)return;b+=d;if(Buffer.byteLength(b)>262144){req.destroy();finish(6)}});',
  'res.on("end",()=>{if(finished)return;if(res.statusCode!==200){finish(5,"__CLAUDE_USAGE_HTTP_"+res.statusCode+"__");return}finish(0,b)})});',
  'req.on("timeout",()=>{req.destroy();finish(7)});req.on("error",()=>finish(7));req.end();',
  '}}',
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

function exposedRootsError(message, reason) {
  const err = new Error(message);
  err.code = 'EXPOSED_ROOTS';
  if (reason) err.reason = reason;
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

function validateSshPort(value, field) {
  if (value === undefined || value === null) return;
  if (!Number.isInteger(value) || value < 1 || value > 65535) {
    throw new Error(`${field} must be an integer between 1 and 65535`);
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

function normalizeEnvKeyList(keys) {
  if (keys === undefined || keys === null) return [];
  if (!Array.isArray(keys)) {
    throw new Error('remote env allowlist must be an array when provided');
  }
  const normalized = [];
  const seen = new Set();
  for (const key of keys) {
    if (typeof key !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      throw envKeyInvalidError(key);
    }
    // Ambient actor credentials are never preservable through an allowlist.
    // The one permitted run-bound capability is reintroduced explicitly by
    // variable reference after env -i.
    if (key === 'PATH' || isActorCredentialKey(key) || seen.has(key)) continue;
    seen.add(key);
    normalized.push(key);
  }
  return normalized;
}

function remoteManagerBaseEnvKeys(vendor) {
  const workerKeys = new Set(WORKER_BASE_ENV_KEYS);
  return MANAGER_BASE_ENV_KEYS(vendor).filter((key) => (
    REMOTE_POD_PROCESS_ENV_KEYS.has(key)
    // Any key outside the shared worker baseline is a manager network/vendor
    // extension selected by MANAGER_BASE_ENV_KEYS and must remain in lockstep
    // with the local manager policy.
    || !workerKeys.has(key)
  ));
}

function buildCleanEnvPrefix(keys) {
  const loopKeys = normalizeEnvKeyList(keys);
  if (loopKeys.length === 0) return 'set --';
  // `${$k+x}` tests existence without materialising an unset key as KEY=.
  // The second eval expands the selected pod variable inside double quotes,
  // so whitespace, quotes, dollars, and glob characters remain one "$@" item.
  return [
    'set --',
    `for k in ${loopKeys.map((key) => shq(key)).join(' ')}`,
    'do eval "v=\\${$k+x}"',
    '[ -n "$v" ] && eval "set -- \\"\\$@\\" \\"$k=\\$$k\\""',
    'done',
  ].join('; ');
}

function normalizeTransportSecret(value, key) {
  if (value === undefined || value === null || value === '') return null;
  if (
    typeof value !== 'string'
    || /[\r\n\x00]/.test(value)
  ) {
    const err = new Error(`${key} must be a non-empty single-line string`);
    err.code = 'SECRET_TRANSPORT_INVALID';
    throw err;
  }
  return value;
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

function filesystemTimeoutError() {
  const err = new Error('Remote filesystem operation timed out');
  err.code = 'ETIMEDOUT';
  return err;
}

function buildCommandScript(command, args = [], {
  cwd,
  env,
  pathPrefix,
  cleanEnv = false,
  cleanEnvKeys = [],
  runBoundTokenKey = null,
  runBoundApiBase = false,
} = {}) {
  const explicitEnv = cleanEnv
    // The pod owns PATH. A controller PATH must never override it; pathPrefix
    // is the sole remote PATH input and is assembled once below.
    ? Object.fromEntries(Object.entries(env || {}).filter(([key]) => key !== 'PATH'))
    : env;
  const envParts = normalizeEnv(explicitEnv);
  const argv = [shq(command), ...(args || []).map((arg) => shq(arg))];
  // Optional PATH prepend for binaries that live outside the pod's minimal
  // non-interactive-ssh PATH (codex/claude under ~/.npm-global/bin). The prefix
  // is shq-quoted (a literal path) and the pod's own PATH expansion is
  // DOUBLE-QUOTED. In the legacy branch below this is an assignment word, which
  // is exempt from field splitting; under `env -i` it is an ordinary argument,
  // where an unquoted $PATH containing a space splits into two arguments and
  // env fails with exit 127 (reproduced on a pod whose PATH held "/opt/my bin").
  const pathAssign = pathPrefix ? `PATH=${shq(pathPrefix)}:"$PATH"` : null;
  if (cleanEnv) {
    const cleanParts = ['exec', 'env', '-i', '"$@"'];
    // PATH is deliberately not collected by the set -- loop. It is emitted
    // exactly once, inside env -i, so the pod shell expands its own PATH and a
    // pathPrefix cannot be lost to simple-command assignment expansion order.
    cleanParts.push(pathAssign || 'PATH="$PATH"');
    cleanParts.push(...envParts);
    const stdinEnvKeys = [
      ...(runBoundTokenKey ? [runBoundTokenKey] : []),
      ...(runBoundApiBase ? ['PALANTIR_API_BASE'] : []),
    ];
    if (stdinEnvKeys.length > 0) {
      normalizeEnvKeyList(stdinEnvKeys);
      // Run-bound values are read from stdin INSIDE the clean shell, never
      // passed as arguments. `env -i ... KEY="$KEY"` would expand a value
      // before exec, so the real /usr/bin/env argv — world-readable through
      // /proc/<pid>/cmdline — would carry it for the life of that exec. Reading
      // here keeps those values in the SSH stdin stream and child environment.
      const stdinBootstrap = stdinEnvKeys.flatMap((key) => [
        `IFS= read -r ${key} || exit 126`,
        `export ${key}`,
      ]);
      cleanParts.push(
        SH_BIN,
        '-c',
        shq([...stdinBootstrap, 'exec "$@"'].join('; ')),
        shq('sh'),
      );
    }
    cleanParts.push(...argv);
    const commandScript = cleanParts.join(' ');
    const prefix = buildCleanEnvPrefix(cleanEnvKeys);
    return cwd
      ? `${prefix}; cd ${shq(cwd)} && ${commandScript}`
      : `${prefix}; ${commandScript}`;
  }
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
  if (spec.stdin !== undefined && typeof spec.stdin !== 'string') {
    throw new Error('spawnWorker stdin must be a string when provided');
  }
  if (spec.systemPrompt !== undefined && typeof spec.systemPrompt !== 'string') {
    throw new Error('spawnWorker systemPrompt must be a string when provided');
  }
  if (
    spec.systemPromptFileFlag !== undefined
    && spec.systemPromptFileFlag !== '--append-system-prompt-file'
  ) {
    throw new Error('spawnWorker systemPromptFileFlag is not allowed');
  }
  if (spec.systemPrompt && !spec.systemPromptFileFlag) {
    throw new Error('spawnWorker systemPrompt requires systemPromptFileFlag');
  }
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
    const segments = typeof spec.workerPath === 'string' ? spec.workerPath.split(':') : [];
    const segmentsValid = segments.length > 0
      && segments.every((segment) => segment.length > 0 && path.posix.isAbsolute(segment));
    if (
      spec.workerPath.length === 0
      || !segmentsValid
      || /[\x00-\x1F\x7F]/.test(spec.workerPath)
    ) {
      throw new Error('spawnWorker workerPath entries must be absolute POSIX paths without control characters');
    }
  }
  normalizeEnvKeyList(spec.envAllowlist);
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
 * chmod, cat, test, mkdir, rm, head, tail, wc, awk, and mv, plus tmux (worker
 * channel spawn/isAlive/kill). readdir implements names only via find and does
 * not support withFileTypes or other readdir options.
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
  validateSshPort(node.ssh_port, 'ssh_port');

  const exposedRoots = parseExposedRoots(node);
  const connectTimeoutSeconds = Math.max(1, Math.ceil(Number(connectTimeoutMs || 10000) / 1000));
  const allowedCommands = new Set((commandAllowlist || []).map(String));
  const managerInteractiveCommands = new Set(['codex', 'claude']);
  let canonicalRootsPromise = null;
  let canonicalRootsValue = null;

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
      ...(node.ssh_port == null ? [] : ['-p', String(node.ssh_port)]),
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
      const hasInput = input !== undefined && input !== null && input !== '';
      const stdoutChunks = [];
      const stderrChunks = [];
      let stdoutBytes = 0;
      let stderrBytes = 0;
      let settled = false;
      let timer = null;

      function isIgnorableEmptyStdinError(err) {
        return !hasInput && ['EPIPE', 'ERR_STREAM_DESTROYED', 'EOF', 'ECONNRESET'].includes(err && err.code);
      }

      // A rejected PAYLOAD WRITE means fewer than `input.length` bytes reached
      // the remote shell. Callers that guard the payload with a byte-count test
      // can use this as PROOF that the commands after that guard never ran; it
      // is the only such proof available, since every other transport error is
      // reported identically whether the remote shell ran or not.
      //
      // The shutdown that follows the write must NOT set this. `end(chunk)`
      // bundles the write with `_final`, and a socket can deliver every byte and
      // still fail its shutdown — that error would otherwise be read as "never
      // delivered" for a payload the remote already acted on. So the payload is
      // written on its own and only that callback marks the failure.
      function markPayloadWriteFailure(err) {
        if (hasInput && err && typeof err === 'object') err.stdinWriteFailed = true;
      }

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
      if (child.stdin && typeof child.stdin.once === 'function') {
        child.stdin.once('error', (err) => {
          if (settled) return;
          // A remote process may exit without reading empty stdin: a normal race
          // whose exit code decides the result. #406 misclassified it as failure.
          if (isIgnorableEmptyStdinError(err)) return;
          if (typeof child.kill === 'function') {
            try { child.kill('SIGTERM'); } catch { /* best-effort */ }
          }
          finishReject(err);
        });
      }
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
        const failStdin = (err, fromPayloadWrite) => {
          // Match the async error path for the normal empty-stdin/remote-exit race.
          if (isIgnorableEmptyStdinError(err)) return;
          if (typeof child.kill === 'function') {
            try { child.kill('SIGTERM'); } catch { /* best-effort */ }
          }
          if (fromPayloadWrite) markPayloadWriteFailure(err);
          finishReject(err);
        };
        if (hasInput && typeof child.stdin.write === 'function') {
          // Separate try blocks, NOT one around both: a throw out of `end()`
          // is a shutdown failure even though the payload write above already
          // succeeded, and sharing a catch would mark it as an undelivered
          // payload — the very misread this split exists to prevent.
          try {
            child.stdin.write(input, (err) => { if (err) failStdin(err, true); });
          } catch (err) {
            failStdin(err, true);
          }
          try {
            child.stdin.end();
          } catch (err) {
            failStdin(err, false);
          }
        } else {
          try {
            child.stdin.end(input === undefined ? '' : input);
          } catch (err) {
            failStdin(err, false);
          }
        }
      }
    });
  }

  function runRemoteCommand(command, args = [], opts = {}) {
    return runRemoteScript(buildCommandScript(command, args, opts), opts);
  }

  function remainingTimeoutMs(deadlineAt) {
    if (deadlineAt === undefined || deadlineAt === null) return undefined;
    const remaining = Math.ceil(Number(deadlineAt) - Date.now());
    if (!Number.isFinite(remaining) || remaining <= 0) throw filesystemTimeoutError();
    return remaining;
  }

  function runFilesystemCommand(command, args = [], { deadlineAt } = {}) {
    const timeoutMs = remainingTimeoutMs(deadlineAt);
    // Deliberately do not opt into cleanEnv here. Filesystem guards and the
    // public git/materialization exec surface keep their established pod-login
    // environment; changing them alongside agent spawn would broaden this
    // security fix into unrelated command behavior and risk regressions.
    return runRemoteCommand(command, args, {
      env: FILESYSTEM_LOCALE_ENV,
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
    });
  }

  function runFilesystemScript(script, { deadlineAt, ...opts } = {}) {
    const timeoutMs = remainingTimeoutMs(deadlineAt);
    const localizedScript = `export LC_ALL=${shq('C')}; ${script}`;
    return runRemoteScript(localizedScript, {
      ...opts,
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
    });
  }

  async function rawRealpath(remotePath, { deadlineAt } = {}) {
    const res = await runFilesystemCommand('realpath', [remotePath], { deadlineAt });
    if (res.code !== 0) throw commandError('realpath', [remotePath], res);
    return stripOneTrailingNewline(res.stdout);
  }

  async function loadCanonicalRoots({ deadlineAt } = {}) {
    const roots = [];
    for (const root of exposedRoots) {
      roots.push(await rawRealpath(root, { deadlineAt }));
    }
    return roots;
  }

  async function canonicalRoots({ deadlineAt } = {}) {
    if (canonicalRootsValue) return canonicalRootsValue;

    // A browse deadline must not poison the executor-wide cache when a stale
    // mount times out. Timed attempts are therefore cached only after success;
    // the intentionally unbounded worker/materialization path keeps its
    // historical shared-promise behaviour.
    if (deadlineAt !== undefined && deadlineAt !== null) {
      const roots = await loadCanonicalRoots({ deadlineAt });
      if (!canonicalRootsValue) {
        canonicalRootsValue = roots;
        canonicalRootsPromise = Promise.resolve(roots);
      }
      return canonicalRootsValue;
    }

    if (!canonicalRootsPromise) {
      canonicalRootsPromise = loadCanonicalRoots().then((roots) => {
        canonicalRootsValue = roots;
        return roots;
      });
    }
    return canonicalRootsPromise;
  }

  function isWithinRoot(canonicalPath, canonicalRoot) {
    if (canonicalRoot === '/') return path.posix.isAbsolute(canonicalPath);
    return canonicalPath === canonicalRoot || canonicalPath.startsWith(`${canonicalRoot}/`);
  }

  async function assertCanonicalWithinRoots(canonicalPath, originalPath, { deadlineAt } = {}) {
    const roots = await canonicalRoots({ deadlineAt });
    if (!roots.some((root) => isWithinRoot(canonicalPath, root))) {
      // Keep EXPOSED_ROOTS as the executor-wide error code for backward
      // compatibility, but distinguish a lexical in-root path whose realpath
      // escaped through a symlink. /api/fs and the save validator expose this
      // reason so operators do not confuse a dangerous link with a typo.
      const normalizedOriginal = path.posix.normalize(originalPath);
      const escapedViaSymlink = exposedRoots.some((root) => (
        isWithinRoot(normalizedOriginal, path.posix.normalize(root))
      ));
      throw exposedRootsError(
        `Remote path is outside exposed_roots: ${originalPath}`,
        escapedViaSymlink ? 'symlink_escape' : undefined,
      );
    }
    return canonicalPath;
  }

  async function assertWithinRoots(
    remotePath,
    { allowMissing = false, parentOnly = false, deadlineAt } = {},
  ) {
    ensureAbsoluteRemotePath(remotePath);
    if (parentOnly) {
      const parentCanonical = await rawRealpath(parentFor(remotePath), { deadlineAt });
      await assertCanonicalWithinRoots(parentCanonical, remotePath, { deadlineAt });
      return { canonical: parentCanonical, exists: false };
    }

    try {
      const canonical = await rawRealpath(remotePath, { deadlineAt });
      await assertCanonicalWithinRoots(canonical, remotePath, { deadlineAt });
      return { canonical, exists: true };
    } catch (err) {
      if (['SSH_TRANSPORT', 'EXPOSED_ROOTS', 'ETIMEDOUT'].includes(err.code)) throw err;
      if (allowMissing) {
        const immediateParent = parentFor(remotePath);
        try {
          const parentCanonical = await rawRealpath(immediateParent, { deadlineAt });
          await assertCanonicalWithinRoots(parentCanonical, remotePath, { deadlineAt });
          return {
            canonical: path.posix.join(parentCanonical, basenameFor(remotePath)),
            parentCanonical,
            exists: false,
          };
        } catch (parentErr) {
          if (['SSH_TRANSPORT', 'EXPOSED_ROOTS', 'ETIMEDOUT'].includes(parentErr.code)) throw parentErr;
        }
        let ancestor = parentFor(remotePath);
        while (true) {
          try {
            const ancestorCanonical = await rawRealpath(ancestor, { deadlineAt });
            await assertCanonicalWithinRoots(ancestorCanonical, remotePath, { deadlineAt });
            return { canonical: null, exists: false };
          } catch (parentErr) {
            if (['SSH_TRANSPORT', 'EXPOSED_ROOTS', 'ETIMEDOUT'].includes(parentErr.code)) throw parentErr;
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
    // This shared path backs git/materialization as well as public exec. It
    // intentionally retains the historical login-shell environment; cleanEnv
    // is an explicit agent-spawn opt-in below, not an executor-wide default.
    return runRemoteCommand(command, args, { cwd: safeCwd, env, timeoutMs, maxBuffer });
  }

  async function spawnInteractive(command, args = [], {
    cwd,
    env,
    pathPrefix,
    envAllowlist,
    worker = false,
  } = {}) {
    const commandName = String(command);
    if (!managerInteractiveCommands.has(commandName)) throw managerCommandNotAllowedError(command);
    // PATH-trust guard: a relative/control-char pathPrefix ('.', 'relative/bin')
    // would let the remote cwd/project supply a fake codex/claude on PATH,
    // defeating the manager-command allowlist. Require an absolute POSIX path
    // without control chars — same contract as the worker channel's workerPath.
    // (Codex P4-S1 review.)
    if (pathPrefix !== undefined && pathPrefix !== null) {
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
        throw new Error('spawnInteractive pathPrefix must be one or more absolute POSIX paths (colon-separated) without control characters');
      }
    }
    let safeCwd = cwd;
    if (cwd) safeCwd = (await assertWithinRoots(cwd)).canonical;
    const explicitEnv = { ...(env || {}) };
    const runBoundTokenKey = worker
      ? 'PALANTIR_WORKER_TOKEN'
      : 'PALANTIR_MANAGER_TOKEN';
    const runBoundToken = normalizeTransportSecret(
      explicitEnv[runBoundTokenKey],
      runBoundTokenKey,
    );
    const workerApiBase = worker && runBoundToken
      ? normalizeWorkerApiBase(explicitEnv.PALANTIR_API_BASE)
      : null;
    delete explicitEnv.PALANTIR_TOKEN;
    delete explicitEnv.PALANTIR_PM_TOKEN;
    delete explicitEnv.PALANTIR_WORKER_TOKEN;
    delete explicitEnv.PALANTIR_MANAGER_TOKEN;
    if (worker) delete explicitEnv.PALANTIR_API_BASE;
    const processEnvKeys = [
      ...(worker ? REMOTE_WORKER_BASE_ENV_KEYS : remoteManagerBaseEnvKeys(commandName)),
      ...normalizeEnvKeyList(envAllowlist),
    ];
    const script = buildCommandScript(commandName, args, {
      cwd: safeCwd,
      // The remote login shell may have controller credentials configured.
      // env -i is the primary boundary; the empty actor assignments remain as
      // defense in depth. A run-bound Manager capability is bootstrapped from
      // SSH stdin below and reintroduced only by variable reference, so its
      // value never appears in the local SSH argv or remote command string.
      env: {
        PALANTIR_TOKEN: null,
        PALANTIR_PM_TOKEN: null,
        ...(worker && runBoundToken ? {} : { PALANTIR_WORKER_TOKEN: null }),
        ...(!worker && runBoundToken ? {} : { PALANTIR_MANAGER_TOKEN: null }),
        ...explicitEnv,
      },
      pathPrefix,
      cleanEnv: true,
      cleanEnvKeys: processEnvKeys,
      runBoundTokenKey: runBoundToken ? runBoundTokenKey : null,
      runBoundApiBase: !!workerApiBase,
    });
    // The run-bound reads happen INSIDE the clean shell (buildCommandScript):
    // reading values out here would require re-injecting them as env -i
    // arguments, which puts them in the real /usr/bin/env argv.
    const bootstrapScript = script;
    const child = spawnFn(
      'ssh',
      sshArgsFor(bootstrapScript, { keepAlive: true }),
      { stdio: ['pipe', 'pipe', 'pipe'] },
    );
    if (runBoundToken) {
      if (!child || !child.stdin || typeof child.stdin.write !== 'function') {
        try { child?.kill?.('SIGTERM'); } catch { /* best-effort */ }
        throw new Error('spawnInteractive requires writable SSH stdin for run capability transport');
      }
      // The caller writes the model prompt only after this async method resolves,
      // so this framed first line is consumed by the bootstrap before the
      // remaining stdin is handed unchanged to codex/claude.
      if (typeof child.stdin.on === 'function') {
        child.stdin.on('error', () => { /* child close/error is authoritative */ });
      }
      try {
        child.stdin.write(
          `${runBoundToken}\n${workerApiBase ? `${workerApiBase}\n` : ''}`,
        );
      } catch (err) {
        try { child.kill?.('SIGTERM'); } catch { /* best-effort */ }
        throw err;
      }
    }
    return child;
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

  /**
   * Resolve the Claude CLI version on this execution node. This is a fixed
   * probe rather than public exec so preset version gates cannot accidentally
   * inspect the Console host while dispatching to an SSH node.
   */
  async function readClaudeVersion({
    timeoutMs = 3000,
    maxBuffer = 4096,
    pathPrefix = node.node_prefix || undefined,
  } = {}) {
    if (pathPrefix !== undefined && pathPrefix !== null) {
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
        throw new Error('readClaudeVersion pathPrefix must be one or more absolute POSIX paths (colon-separated) without control characters');
      }
    }
    const script = pathPrefix
      ? `exec env PATH=${shq(pathPrefix)}:"$PATH" claude --version`
      : 'exec claude --version';
    const result = await runRemoteScript(script, { timeoutMs, maxBuffer });
    if (result.code !== 0) return null;
    const match = String(result.stdout || '').match(/(\d+\.\d+\.\d+)/);
    return match ? match[1] : null;
  }

  async function fileExists(remotePath) {
    const checked = await assertWithinRoots(remotePath, { allowMissing: true });
    if (!checked.exists) return false;
    const res = await runFilesystemCommand('test', ['-e', checked.canonical]);
    if (res.code === 0) return true;
    if (res.code === 1) return false;
    throw commandError('test', ['-e', remotePath], res);
  }

  async function realpath(remotePath, options = {}) {
    const checked = await assertWithinRoots(remotePath, options);
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
    const res = await runFilesystemCommand(
      'find',
      [checked.canonical, '-mindepth', '1', '-maxdepth', '1', '-print'],
    );
    if (res.code !== 0) throw commandError('find', [checked.canonical], res);
    return res.stdout.split('\n').filter(Boolean).map((entry) => path.posix.basename(entry));
  }

  // task_85d43f96: one-round-trip directory listing for the node-aware
  // DirectoryPicker. `readdir` above returns names only, so a picker listing
  // would otherwise cost an extra `test -d` round-trip per child. `%y` reports
  // the type of the entry ITSELF (find does not follow symlinks without -L),
  // so a symlinked directory is reported as 'l' and never surfaces as a
  // browsable child — a listed entry can never be a symlink that escapes
  // exposed_roots. Navigating INTO any path still goes through
  // assertWithinRoots (realpath + canonical root containment) first, so a
  // symlink escape that was typed or stored elsewhere is rejected fail-closed.
  async function listDirectoryEntries(remotePath, { maxEntries = 2000, deadlineAt } = {}) {
    const checked = await assertWithinRoots(remotePath, { deadlineAt });
    const cap = Math.max(1, Number(maxEntries) || 2000);
    const p = shq(checked.canonical);
    // Same FINDEXIT marker discipline as listFilesWithSizes: dash has no
    // `pipefail`, so `find | head` reports head's status (0) even when find
    // failed on an unreadable directory — a silent EMPTY listing that looks
    // like "no subfolders". The marker is printed by the same group, so a
    // missing marker means head truncated the walk and a nonzero marker means
    // find itself failed.
    //
    // NOTDIR guard, in the SAME round trip: `find <regular file> -mindepth 1`
    // exits 0 and prints nothing, so without this a file (or FIFO/socket) came
    // back as a successful EMPTY listing. The node-change validator reads that
    // as "path is valid on this node" and the save-time binding check only
    // tests existence, so a project directory could be rebound to a file and
    // only fail much later when it is used as a working directory.
    // assertWithinRoots already realpath'd the target, so it exists here —
    // `! -d` therefore means "exists but is not a directory".
    const script = `if [ ! -d ${p} ]; then printf 'NOTDIR\\0'; else { find ${p} -mindepth 1 -maxdepth 1 -printf '%y\\t%P\\0'; printf 'FINDEXIT:%s\\0' "$?"; } | head -z -n ${cap + 2}; fi`;
    const res = await runFilesystemScript(script, {
      deadlineAt,
      maxBuffer: 4 * 1024 * 1024,
      ...(deadlineAt === undefined || deadlineAt === null ? { timeoutMs: 30000 } : {}),
    });
    if (res.code !== 0 && !res.stdout) throw commandError('listDirectoryEntries', [checked.canonical], res);
    const records = String(res.stdout).split('\0').filter((s) => s.length > 0);
    if (records.length === 1 && records[0] === 'NOTDIR') {
      const err = new Error(`Remote path is not a directory: ${checked.canonical}`);
      err.code = 'ENOTDIR';
      err.status = 400;
      err.reason = 'path_not_directory';
      throw err;
    }
    let findComplete = false;
    if (records.length && records[records.length - 1].startsWith('FINDEXIT:')) {
      const code = Number(records.pop().slice('FINDEXIT:'.length));
      if (Number.isFinite(code) && code !== 0) {
        throw commandError('find', [checked.canonical], {
          code,
          stdout: '',
          stderr: res.stderr || 'find exited nonzero',
        });
      }
      findComplete = true;
    }
    const truncated = !findComplete || records.length > cap;
    const entries = [];
    for (const rec of records.slice(0, cap)) {
      const tab = rec.indexOf('\t');
      if (tab < 0) continue;
      const type = rec.slice(0, tab);
      const name = rec.slice(tab + 1);
      // `%P` at -maxdepth 1 is a bare basename; anything else is a malformed
      // record (or a forged one) and is dropped rather than joined onto a path.
      if (!name || name === '.' || name === '..' || name.includes('/')) continue;
      entries.push({ name, isDirectory: type === 'd' });
    }
    return { path: checked.canonical, entries, truncated };
  }

  // task_85d43f96: the picker needs the CANONICAL roots to decide where the
  // "up" affordance must stop. Read-only view of the already-cached values.
  async function canonicalExposedRoots({ deadlineAt } = {}) {
    return [...(await canonicalRoots({ deadlineAt }))];
  }

  async function stat(remotePath, options = {}) {
    const checked = await assertWithinRoots(remotePath, options);
    const dirRes = await runFilesystemCommand('test', ['-d', checked.canonical], options);
    if (dirRes.code !== 0 && dirRes.code !== 1) throw commandError('test', ['-d', checked.canonical], dirRes);
    const fileRes = await runFilesystemCommand('test', ['-f', checked.canonical], options);
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

  async function rmrf(remotePath, { deadlineAt } = {}) {
    const checked = await assertWithinRoots(remotePath, { allowMissing: true, deadlineAt });
    if (!checked.exists) return;
    const roots = await canonicalRoots({ deadlineAt });
    if (roots.some((root) => checked.canonical === root)) {
      throw exposedRootsError(`Refusing to remove exposed root: ${remotePath}`);
    }
    const res = await runRemoteCommand('rm', ['-rf', checked.canonical], {
      timeoutMs: remainingTimeoutMs(deadlineAt),
    });
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
      structuredResult: path.posix.join(statusDir, 'result.jsonl'),
      structuredResultTmp: path.posix.join(statusDir, 'result.jsonl.tmp'),
      exitSentinel: path.posix.join(statusDir, 'exit.code'),
      stdinFile: path.posix.join(statusDir, 'stdin.txt'),
      systemPromptFile: path.posix.join(statusDir, 'system-prompt.txt'),
      workerTokenFile: path.posix.join(statusDir, 'worker-capability'),
      workerApiBaseFile: path.posix.join(statusDir, 'worker-api-base'),
      uploadBundle: path.posix.join(statusDir, 'worker-input.bundle'),
    };
  }

  function buildWorkerInvocation({
    command,
    args = [],
    env,
    workerPath,
    envAllowlist,
  }, {
    workerTokenFile = null,
    workerApiBaseFile = null,
  } = {}) {
    // env -i is the primary ambient-credential boundary. Empty actor
    // assignments remain as defense in depth; the server-selected run
    // capability is restored only by variable reference after env -i.
    const workerEnv = { ...(env || {}) };
    // The pod owns PATH. A profile that allowlists PATH materializes the
    // CONTROLLER's value into spec.env; appending it after the pod assembly
    // would overwrite prefix+pod PATH with a path that does not exist on the
    // pod. The manager path drops it for the same reason.
    delete workerEnv.PATH;
    delete workerEnv.PALANTIR_TOKEN;
    delete workerEnv.PALANTIR_PM_TOKEN;
    delete workerEnv.PALANTIR_WORKER_TOKEN;
    delete workerEnv.PALANTIR_MANAGER_TOKEN;
    delete workerEnv.PALANTIR_API_BASE;
    const envParts = normalizeEnv({
      PALANTIR_TOKEN: null,
      PALANTIR_PM_TOKEN: null,
      ...(workerTokenFile ? {} : { PALANTIR_WORKER_TOKEN: null }),
      PALANTIR_MANAGER_TOKEN: null,
      ...workerEnv,
    });
    const list = Array.isArray(args) ? args : [];
    const argv = [shq(command), ...list.map((arg) => shq(arg))];
    const cleanEnvKeys = [
      ...REMOTE_WORKER_BASE_ENV_KEYS,
      ...normalizeEnvKeyList(envAllowlist),
    ];
    // Do not exec here: the tmux shell must remain to capture the agent exit
    // code, remove a prompt file, and write the exit sentinel after the child
    // returns.
    const cleanParts = ['env', '-i', '"$@"'];
    // Assemble PATH exactly once inside env -i. Keeping this out of an outer
    // assignment is required: all simple-command expansions happen before
    // assignment application and would otherwise discard workerPath.
    cleanParts.push(workerPath ? `PATH=${shq(workerPath)}:"$PATH"` : 'PATH="$PATH"');
    cleanParts.push(...envParts);
    if (workerTokenFile) {
      // Same argv contract as the manager path: the capability is read from its
      // 0600 file INSIDE the clean shell. Passing it as `KEY="$KEY"` would place
      // the value in the real /usr/bin/env argv, which /proc exposes.
      cleanParts.push(
        SH_BIN,
        '-c',
        shq([
          // Capture the read status, clean up UNCONDITIONALLY, and only then
          // act on it. Exiting on a failed `cat` before the rm would retain the
          // capability until the later run-status cleanup path.
          `PALANTIR_WORKER_TOKEN=$(cat -- ${shq(workerTokenFile)})`,
          'worker_token_rc=$?',
          `rm -f -- ${shq(workerTokenFile)}`,
          '[ "$worker_token_rc" -eq 0 ] || exit 78',
          'export PALANTIR_WORKER_TOKEN',
          ...(workerApiBaseFile
            ? [
                `PALANTIR_API_BASE=$(cat -- ${shq(workerApiBaseFile)})`,
                'worker_api_base_rc=$?',
                `rm -f -- ${shq(workerApiBaseFile)}`,
                '[ "$worker_api_base_rc" -eq 0 ] || exit 78',
                'export PALANTIR_API_BASE',
              ]
            : []),
          'exec "$@"',
        ].join('; ')),
        shq('sh'),
      );
    }
    cleanParts.push(...argv);
    const commandLine = `${buildCleanEnvPrefix(cleanEnvKeys)}; ${cleanParts.join(' ')}`;
    return commandLine;
  }

  async function ensureWorkerStatusDir(paths) {
    await mkdir(paths.runsRoot, { recursive: true });
    await mkdir(paths.statusDir, { recursive: true });
  }

  function resolveWorkerRequest(workerRequest) {
    if (
      workerRequest
      && typeof workerRequest === 'object'
      && Object.prototype.hasOwnProperty.call(workerRequest, 'engine')
    ) {
      if (!['cli', 'stream-json'].includes(workerRequest.engine)) {
        throw new Error(`unsupported remote worker engine: ${workerRequest.engine}`);
      }
      return { engine: workerRequest.engine, spec: workerRequest.spec };
    }
    return { engine: 'cli', spec: workerRequest };
  }

  async function classifyUncertainDetachedStart(err, paths, materializedFiles = []) {
    const mayHaveCrossedSshBoundary = !!err && (
      DETACHED_START_TRANSPORT_ERROR_CODES.has(err.code)
      || err.exitCode === 255
      || err.killed === true
      || typeof err.signal === 'string'
    );
    if (!mayHaveCrossedSshBoundary) return false;

    // The start command may already have crossed the SSH boundary, so the
    // default is uncertainty: never delete files a pane may not have opened
    // yet, and never let a retry race a start we cannot see.
    //
    // Exactly one exception is admissible, and it is STRUCTURAL rather than
    // observational. When the payload is uploaded, the remote script is a
    // single `&&` chain whose byte-count guard precedes `tmux new-session`:
    //
    //   head -c N > bundle && [ "$(wc -c < bundle)" -eq N ] && ... && tmux ...
    //
    // A rejected stdin write means fewer than N bytes arrived, so that guard
    // fails and the start command provably never ran. The absence of a spawn
    // is then proved by the remote script's own control flow.
    //
    // Probing is worth a round-trip only when that exception is in play; every
    // other path ends at uncertainty regardless, and this is exactly the moment
    // the link is already unwell.
    if (err.stdinWriteFailed && materializedFiles.length > 0) {
      // The probes are asymmetric ON PURPOSE. A hit is positive evidence that
      // this run already owns a pane — retries carry a fresh run id, so a
      // session under THIS run's name can only be this run's own start, and it
      // overrides the structural argument. Absence proves nothing: both report
      // state at probe time, and an exec request that reached sshd can still
      // start its pane after the probe answers. Licensing a retry on "not there
      // yet" is what puts two workers in one remote cwd.
      const observed = async (command, args) => {
        try {
          return (await runRemoteCommand(command, args)).code === 0;
        } catch {
          return false;
        }
      };
      // The pane writes exit.code only after the worker and its result capture
      // finish, so a sentinel means a start that has already completed.
      if (!await observed('tmux', ['has-session', '-t', paths.sessionName])
          && !await observed('test', ['-f', paths.exitSentinel])) {
        return false;
      }
    }

    err.transportCode = err.code;
    err.code = 'REMOTE_SPAWN_UNCERTAIN';
    err.sessionName = paths.sessionName;
    err.preserveRemoteFiles = true;
    return true;
  }

  async function spawnWorker(runId, workerRequest) {
    const { engine, spec } = resolveWorkerRequest(workerRequest);
    validateWorkerSpec(spec);
    const paths = workerPaths(runId);
    const safeCwd = (await assertWithinRoots(spec.cwd)).canonical;
    await ensureWorkerStatusDir(paths);

    const workerToken = normalizeTransportSecret(
      spec.env && spec.env.PALANTIR_WORKER_TOKEN,
      'PALANTIR_WORKER_TOKEN',
    );
    const workerApiBase = workerToken
      ? normalizeWorkerApiBase(spec.env && spec.env.PALANTIR_API_BASE)
      : null;
    let workerTokenFile = null;
    let workerApiBaseFile = null;
    try {
      if (workerToken) {
        // Keep the scoped capability in the deterministic run status directory.
        // It is uploaded in the same guarded SSH handoff as the prompts, so an
        // uncertain start can always be reaped later by kill()/cleanupRun() even
        // after an executor/server restart. The detached child deletes it before
        // exec, and only this fixed path (never the value) enters argv.
        const tokenParent = await assertWithinRoots(
          paths.workerTokenFile,
          { parentOnly: true },
        );
        workerTokenFile = path.posix.join(
          tokenParent.canonical,
          path.posix.basename(paths.workerTokenFile),
        );
      }
      if (workerApiBase) {
        const apiBaseParent = await assertWithinRoots(
          paths.workerApiBaseFile,
          { parentOnly: true },
        );
        workerApiBaseFile = path.posix.join(
          apiBaseParent.canonical,
          path.posix.basename(paths.workerApiBaseFile),
        );
      }
      let canonicalStdin = null;
      if (spec.stdin !== undefined) {
        // Resolve the prompt path BEFORE the file exists so upload and handoff can
        // share one SSH invocation (see the crash-safety note below).
        //
        // Canonicalise the PARENT only, then append the fixed basename — never
        // realpath the final component. Resolving it would follow a pre-existing
        // `stdin.txt` symlink, and since a link pointing at another in-root file
        // passes the exposed-roots check, the upload below would delete that file
        // and overwrite it with the prompt. Naming the parent's canonical child
        // instead means `rm` unlinks the link itself (rm never follows a final
        // symlink) and `cat` then creates a fresh regular file.
        const promptParent = await assertWithinRoots(paths.stdinFile, { parentOnly: true });
        canonicalStdin = path.posix.join(promptParent.canonical, path.posix.basename(paths.stdinFile));
      }
      let canonicalSystemPrompt = null;
      if (spec.systemPrompt !== undefined) {
        const systemPromptParent = await assertWithinRoots(
          paths.systemPromptFile,
          { parentOnly: true },
        );
        canonicalSystemPrompt = path.posix.join(
          systemPromptParent.canonical,
          path.posix.basename(paths.systemPromptFile),
        );
      }
      let canonicalUploadBundle = null;
      if (workerTokenFile || workerApiBaseFile || canonicalSystemPrompt || canonicalStdin) {
        const bundleParent = await assertWithinRoots(
          paths.uploadBundle,
          { parentOnly: true },
        );
        canonicalUploadBundle = path.posix.join(
          bundleParent.canonical,
          path.posix.basename(paths.uploadBundle),
        );
      }

      const effectiveSpec = canonicalSystemPrompt
        ? {
            ...spec,
            args: [
              ...(spec.args || []),
              spec.systemPromptFileFlag,
              canonicalSystemPrompt,
            ],
          }
        : spec;
      const workerInvocation = buildWorkerInvocation(effectiveSpec, {
        workerTokenFile,
        workerApiBaseFile,
      });
      const materializedFiles = [
        canonicalStdin,
        canonicalSystemPrompt,
        workerTokenFile,
        workerApiBaseFile,
        canonicalUploadBundle,
      ].filter(Boolean);
      const stdinRedirect = canonicalStdin ? ` < ${shq(canonicalStdin)}` : '';
      const cleanupPromptCommand = materializedFiles.length > 0
        ? `rm -f -- ${materializedFiles.map((file) => shq(file)).join(' ')}`
        : '';
      const cleanupPrompt = cleanupPromptCommand ? `; ${cleanupPromptCommand}` : '';
      const promptTrap = cleanupPromptCommand
        ? `trap ${shq(cleanupPromptCommand)} EXIT HUP INT TERM; `
        : '';
      const clearPromptTrap = cleanupPromptCommand ? '; trap - EXIT HUP INT TERM' : '';
      const captureStructuredResult = engine === 'stream-json'
        ? [
            `; awk ${shq('/^[[:space:]]*\\{[[:space:]]*"type"[[:space:]]*:[[:space:]]*"result"/ { last=$0 } END { if (last != "") print last }')} ${shq(paths.stdoutLog)} > ${shq(paths.structuredResultTmp)}`,
            `chmod 600 ${shq(paths.structuredResultTmp)}`,
            `mv -f ${shq(paths.structuredResultTmp)} ${shq(paths.structuredResult)}`,
          ].join(' && ')
        : '';
      // Remove BEFORE disarming the trap: clearing it first leaves a window where
      // a HUP/TERM arriving before the `rm` has no handler left to run.
      const exitWrite = cleanupPromptCommand
        ? `; agent_exit_code=$?${captureStructuredResult}${cleanupPrompt}${clearPromptTrap}; echo "$agent_exit_code" > ${shq(paths.exitSentinel)}`
        : captureStructuredResult
          ? `; agent_exit_code=$?${captureStructuredResult}; echo "$agent_exit_code" > ${shq(paths.exitSentinel)}`
          : `; echo $? > ${shq(paths.exitSentinel)}`;
      const uploads = [
        workerTokenFile
          ? { path: workerTokenFile, content: workerToken }
          : null,
        workerApiBaseFile
          ? { path: workerApiBaseFile, content: workerApiBase }
          : null,
        canonicalSystemPrompt
          ? { path: canonicalSystemPrompt, content: spec.systemPrompt }
          : null,
        canonicalStdin
          ? { path: canonicalStdin, content: spec.stdin }
          : null,
      ].filter(Boolean);
      let uploadOffset = 0;
      const uploadSlices = uploads.map((upload) => {
        const bytes = Buffer.byteLength(upload.content, 'utf8');
        const slice = { ...upload, bytes, offset: uploadOffset };
        uploadOffset += bytes;
        return slice;
      });
      const extractCommands = uploadSlices.flatMap((upload) => {
        const extract = upload.bytes === 0
          ? `: > ${shq(upload.path)}`
          : upload.offset === 0
            ? `head -c ${upload.bytes} ${shq(canonicalUploadBundle)} > ${shq(upload.path)}`
            : `tail -c +${upload.offset + 1} ${shq(canonicalUploadBundle)} | head -c ${upload.bytes} > ${shq(upload.path)}`;
        return [
          extract,
          `[ "$(wc -c < ${shq(upload.path)})" -eq ${upload.bytes} ]`,
        ];
      });
      const materializeInputs = uploadSlices.length > 0
        ? [
            'set -C',
            ...extractCommands,
            'set +C',
            `chmod 600 -- ${uploads.map((upload) => shq(upload.path)).join(' ')}`,
            `rm -f -- ${shq(canonicalUploadBundle)}`,
          ].join(' && ') + ' && '
        : '';
      // tmux server processes can predate this SSH request and retain a broad
      // umask. Set it inside the pane-owned shell so stdout/result/sentinel
      // files remain 0600 regardless of the server's inherited environment.
      // buildWorkerInvocation is a compound list (`set --; ...; env ...`).
      // Group it so materialization's final `&&` guards the ENTIRE invocation,
      // not only its first `set --` command.
      const guardedWorkerInvocation = uploadSlices.length > 0
        ? `( ${workerInvocation} )`
        : workerInvocation;
      const innerScript = `umask 077; ${promptTrap}${materializeInputs}${guardedWorkerInvocation}${stdinRedirect} > ${shq(paths.stdoutLog)} 2>&1${exitWrite}`;
      const startWorker = `cd ${shq(safeCwd)} && tmux new-session -d -s ${shq(paths.sessionName)} ${shq(innerScript)}`;

      if (materializedFiles.length === 0) {
        let res;
        try {
          res = await runRemoteScript(startWorker);
        } catch (err) {
          await classifyUncertainDetachedStart(err, paths);
          throw err;
        }
        if (res.code !== 0) {
          throw commandError('tmux', ['new-session', '-d', '-s', paths.sessionName], res);
        }
        return { sessionName: paths.sessionName };
      }

      // User/system prompt upload and tmux handoff MUST be one SSH invocation.
      // A single mode-0600 bundle consumes SSH stdin; the pane extracts each
      // destination from that regular file. Multiple `head` readers on the live
      // pipe are unsafe because some implementations read ahead and discard
      // bytes belonging to the next payload.
      //
      // Arming the trap before `cat` closes that window from the remote side — the
      // controller dying drops the SSH connection, the remote shell takes SIGHUP,
      // and the handler removes the prompt. It is disarmed only once tmux owns the
      // file, after which the worker's own trap is responsible for it.
      const uploadInput = uploads.map((upload) => upload.content).join('');
      const bundleBytes = Buffer.byteLength(uploadInput, 'utf8');
      const writeBundle = bundleBytes > 0
        ? `head -c ${bundleBytes} > ${shq(canonicalUploadBundle)}`
        : `: > ${shq(canonicalUploadBundle)}`;
      const script = [
        'umask 077',
        `cleanup() { ${cleanupPromptCommand}; }`,
        `trap 'rc=$?; cleanup; exit "$rc"' 0`,
        `trap 'exit 129' HUP`,
        `trap 'exit 130' INT`,
        `trap 'exit 143' TERM`,
        cleanupPromptCommand,
        'set -C',
        writeBundle,
        `[ "$(wc -c < ${shq(canonicalUploadBundle)})" -eq ${bundleBytes} ]`,
        'set +C',
        `chmod 600 -- ${shq(canonicalUploadBundle)}`,
        startWorker,
        'trap - 0 HUP INT TERM',
      ].join(' && ');

      let res;
      try {
        res = await runRemoteScript(script, { input: uploadInput });
      } catch (err) {
        // The remote trap handles a dropped connection; this covers a local-side
        // rejection where the remote shell may never have run at all.
        const uncertain = await classifyUncertainDetachedStart(err, paths, materializedFiles);
        if (!uncertain) {
          try { await runRemoteCommand('rm', ['-f', ...materializedFiles]); } catch {}
        }
        throw err;
      }
      if (res.code !== 0) {
        try { await runRemoteCommand('rm', ['-f', ...materializedFiles]); } catch {}
        throw commandError('tmux', ['new-session', '-d', '-s', paths.sessionName], res);
      }
      return { sessionName: paths.sessionName };
    } catch (err) {
      const capabilityFiles = [workerTokenFile, workerApiBaseFile].filter(Boolean);
      if (capabilityFiles.length > 0 && !err.preserveRemoteFiles) {
        try { await runRemoteCommand('rm', ['-f', ...capabilityFiles]); } catch {}
      }
      throw err;
    }
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

  async function getStructuredResult(runId) {
    const paths = workerPaths(runId);
    try {
      const checked = await assertWithinRoots(paths.structuredResult, { allowMissing: true });
      if (!checked.exists) return '';
      const res = await runRemoteCommand('cat', [checked.canonical], {
        maxBuffer: CLAUDE_RESULT_MAX_BUFFER,
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
    // A killed tmux shell may not reach its normal post-command cleanup.
    // Prompt/capability files are controller-owned and live inside the validated
    // status dir, so this also reaps an uncertain start that never gained an owner.
    try {
      await runRemoteCommand('rm', [
        '-f',
        paths.stdinFile,
        paths.systemPromptFile,
        paths.workerTokenFile,
        paths.workerApiBaseFile,
        paths.uploadBundle,
        paths.structuredResultTmp,
      ]);
    } catch {}
    return res.code === 0;
  }

  async function cleanupRun(runId) {
    const paths = workerPaths(runId);
    await rmrf(paths.statusDir, { deadlineAt: Date.now() + connectTimeoutMs });
  }

  return {
    exec,
    spawnInteractive,
    readClaudeOAuthUsage,
    readClaudeVersion,
    spawnWorker,
    ownerOf,
    isAlive,
    detectExitCode,
    getOutput,
    getStructuredResult,
    sendInput,
    kill,
    cleanupRun,
    fileExists,
    realpath,
    stat,
    mkdir,
    ensureRealDir,
    listDirectoryEntries,
    canonicalExposedRoots,
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
  CLAUDE_OAUTH_USAGE_JS,
};
