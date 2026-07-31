const crypto = require('node:crypto');
const fsp = require('node:fs/promises');
const path = require('node:path');

const MAX_EVENT_BYTES = 16 * 1024;
const MAX_TREE_NODES = 64;
const DEFAULT_TIMEOUT_MS = 1500;
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const BASENAME_RE = /^[A-Za-z0-9._-]{1,64}$/;

// Keep this independent from agentProfileService's environment-extended set:
// custom commands may contain operator paths or other user-controlled text.
const BUILTIN_COMMANDS = new Set([
  'claude', 'codex', 'gemini',
  '/opt/homebrew/bin/claude', '/opt/homebrew/bin/codex',
  '/opt/homebrew/bin/gemini',
  '/usr/local/bin/claude', '/usr/local/bin/codex',
  '/usr/local/bin/gemini',
]);

// Exact flag-name enum used by both profile template keys and live argv.
// Tokens containing an attached value (for example --model=secret) are not
// exact members and therefore remain redacted in argv.
const KNOWN_FLAGS = new Set([
  '-a', '-c', '-C', '-i', '-m', '-o', '-p', '-s', '-y',
  '--add-dir', '--allowed-tools', '--allowedTools',
  '--allowed-mcp-server-names', '--append-system-prompt',
  '--approval-mode', '--ask-for-approval', '--bare', '--cd', '--color',
  '--config', '--dangerously-bypass-approvals-and-sandbox',
  '--dangerously-skip-permissions', '--debug', '--delete-session',
  '--disable', '--disable-slash-commands', '--disallowed-tools',
  '--disallowedTools', '--enable', '--extensions', '--full-auto', '--help',
  '--image', '--include-directories', '--json', '--list-extensions',
  '--list-sessions', '--local-provider', '--max-budget-usd', '--max-turns',
  '--mcp-config', '--model', '--no-chrome', '--output-format',
  '--output-last-message', '--output-schema', '--permission-mode', '--profile',
  '--prompt', '--remote', '--remote-auth-token-env', '--resume', '--safe-mode',
  '--sandbox', '--schema', '--setting-sources', '--settings',
  '--skip-git-repo-check', '--strict-mcp-config', '--system-prompt', '--tools',
  '--verbose', '--version', '--yolo',
]);

const ERROR_CODES = new Set([
  'ps_failed',
  'proc_unreadable',
  'remote_timeout',
  'unsupported_platform',
]);
const STATES = new Set(['R', 'S', 'D', 'T', 'Z', 'I']);

function validId(value) {
  const text = typeof value === 'string' ? value : '';
  return ID_RE.test(text) ? text : '<invalid-id>';
}

// A basename is NOT inherently safe: it is attacker-influenced input (a remote
// executor's ps output, or a worker that exec'd a temp file). `/tmp/TOK_9C2D`
// has a basename that passes any character-class check, so codex demonstrated
// raw secrets surviving into the payload. Treat it like profile.command: known
// executables pass through for observability, everything else collapses to a
// stable hash so identical binaries still group without carrying their name.
const KNOWN_EXECUTABLES = new Set([
  'node', 'npm', 'npx', 'deno', 'bun',
  'python', 'python3', 'pip', 'pip3',
  'sh', 'bash', 'zsh', 'dash', 'env', 'tmux', 'ssh', 'sshd',
  'git', 'make', 'cargo', 'go', 'ruby', 'java',
  'codex', 'claude', 'gemini', 'opencode',
]);

function safeBasename(value) {
  const base = path.basename(typeof value === 'string' ? value : '');
  if (!BASENAME_RE.test(base)) return '<invalid>';
  if (KNOWN_EXECUTABLES.has(base)) return base;
  return `custom:${crypto.createHash('sha256').update(base, 'utf8').digest('hex').slice(0, 8)}`;
}

function safeCommand(value) {
  const command = typeof value === 'string' ? value : '';
  if (BUILTIN_COMMANDS.has(command)) return command;
  const digest = crypto.createHash('sha256').update(command, 'utf8').digest('hex');
  return `custom:${digest.slice(0, 8)}`;
}

function flagName(token) {
  if (typeof token !== 'string' || token === '--' || !token.startsWith('-')) return null;
  const equals = token.indexOf('=');
  return equals === -1 ? token : token.slice(0, equals);
}

// Bound the INPUT, not just the output. Tokenizing a whole args_template and
// only then slicing to 4096 meant an oversized template paid full parse cost —
// codex measured 51-62ms synchronous on a 1.9MB value. Nothing downstream can
// use more than TOKEN_LIMIT tokens, so stop reading once we have them.
const TOKEN_LIMIT = 4096;
const TEMPLATE_SCAN_BYTES = 256 * 1024;

function tokenizeTemplate(value) {
  const text = String(value || '');
  const scanned = text.length > TEMPLATE_SCAN_BYTES ? text.slice(0, TEMPLATE_SCAN_BYTES) : text;
  const pattern = /(?:[^\s"']+|"[^"]*"|'[^']*')+/g;
  const tokens = [];
  let match = pattern.exec(scanned);
  while (match && tokens.length <= TOKEN_LIMIT) {
    tokens.push(match[0].replace(/^(?:"([\s\S]*)"|'([\s\S]*)')$/, (_m, dq, sq) => dq ?? sq));
    match = pattern.exec(scanned);
  }
  // Signal truncation to templateKeys the same way an oversized array does.
  if (text.length > scanned.length && tokens.length <= TOKEN_LIMIT) tokens.push('');
  return tokens;
}

function templateKeys(profile) {
  const source = Array.isArray(profile?.args_template_keys)
    ? profile.args_template_keys
    : tokenizeTemplate(profile?.args_template);
  const keys = [];
  for (const token of source.slice(0, TOKEN_LIMIT)) {
    const name = flagName(token);
    if (!name) continue;
    keys.push(KNOWN_FLAGS.has(name) ? name : '<unknown-flag>');
  }
  return { keys, clipped: source.length > TOKEN_LIMIT };
}

function safeArgv(argv) {
  if (!Array.isArray(argv) || argv.length === 0) return { argv: [], clipped: false };
  const source = argv.slice(0, 4096);
  const result = [safeBasename(source[0])];
  for (const token of source.slice(1)) {
    const text = typeof token === 'string' ? token : String(token ?? '');
    result.push(KNOWN_FLAGS.has(text)
      ? text
      : `<redacted:${Buffer.byteLength(text, 'utf8')}>`);
  }
  return { argv: result, clipped: argv.length > source.length };
}

function safeNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function safeTreeNode(node) {
  const result = {};
  for (const key of ['pid', 'ppid', 'pgid', 'cputime_s']) {
    const value = safeNumber(node?.[key]);
    if (value !== undefined) result[key] = value;
  }
  const state = typeof node?.state === 'string' ? node.state.slice(0, 1) : '';
  result.state = STATES.has(state) ? state : '?';
  result.exe_basename = safeBasename(node?.exe_basename ?? node?.exe);
  return result;
}

function safeCount(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.trunc(value)
    : 0;
}

function validCalendarDate(year, month, day, hour, minute, second, millis = 0) {
  const date = new Date(Date.UTC(year, month - 1, day, hour, minute, second, millis));
  return date.getUTCFullYear() === year
    && date.getUTCMonth() === month - 1
    && date.getUTCDate() === day
    && date.getUTCHours() === hour
    && date.getUTCMinutes() === minute
    && date.getUTCSeconds() === second;
}

function safeTimestamp(value) {
  if (typeof value !== 'string') return null;
  const sqlite = value.match(
    /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?$/,
  );
  if (sqlite) {
    const [, y, mo, d, h, mi, s, fraction = '0'] = sqlite;
    return validCalendarDate(
      Number(y), Number(mo), Number(d), Number(h), Number(mi), Number(s),
      Number(fraction.padEnd(3, '0')),
    ) ? value : null;
  }
  const iso = value.match(
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|[+-]\d{2}:\d{2})$/,
  );
  if (!iso || !Number.isFinite(Date.parse(value))) return null;
  const [, y, mo, d, h, mi, s] = iso;
  return validCalendarDate(Number(y), Number(mo), Number(d), Number(h), Number(mi), Number(s))
    ? value
    : null;
}

function serializedBytes(payload) {
  return Buffer.byteLength(JSON.stringify(payload), 'utf8');
}

/**
 * Rebuild a snapshot from the complete allowlist. Unknown input properties,
 * including env and cmdline, are never copied into the result.
 */
function serializeWorkerSnapshot(input = {}) {
  const profileInput = input.profile && typeof input.profile === 'object' ? input.profile : {};
  const { keys, clipped: keysClipped } = templateKeys(profileInput);
  const { argv, clipped: argvClipped } = safeArgv(input.argv);
  const rawTree = Array.isArray(input.tree) ? input.tree : [];
  const tree = rawTree.slice(0, MAX_TREE_NODES).map(safeTreeNode);
  let truncated = Boolean(input.truncated)
    || keysClipped
    || argvClipped
    || rawTree.length > MAX_TREE_NODES;

  const payload = {
    run_id: validId(input.run_id),
    profile_id: validId(input.profile_id),
    node_id: validId(input.node_id),
    profile: {
      command: safeCommand(profileInput.command),
      type: ['codex', 'claude-code', 'gemini'].includes(profileInput.type)
        ? profileInput.type
        : 'other',
      args_template_keys: keys,
    },
    argv,
    tree,
    fd_summary: {
      file: safeCount(input.fd_summary?.file),
      socket: safeCount(input.fd_summary?.socket),
      pipe: safeCount(input.fd_summary?.pipe),
      other: safeCount(input.fd_summary?.other),
    },
    last_output_at: safeTimestamp(input.last_output_at),
    collect_errors: [...new Set(
      (Array.isArray(input.collect_errors) ? input.collect_errors : [])
        .filter(code => ERROR_CODES.has(code)),
    )],
  };

  if (truncated) payload.truncated = true;
  if (serializedBytes(payload) <= MAX_EVENT_BYTES) return payload;

  truncated = true;
  payload.truncated = true;
  // Shed with a BINARY SEARCH, not one pop per stringify. The naive loop
  // re-serialized the whole payload for every removed element, so shedding was
  // O(n^2) on the array length — codex measured 535ms at the 4096 cap, which a
  // collection deadline cannot cover because the work is synchronous. Each
  // array now costs O(log n) serializations.
  //
  // Shed order preserves process evidence longest: template repetition and
  // trailing argv answer less than the tree does about why the run remained.
  const shedTargets = [
    { get: () => payload.profile.args_template_keys, set: v => { payload.profile.args_template_keys = v; }, floor: 0 },
    { get: () => payload.argv, set: v => { payload.argv = v; }, floor: 1 },
    { get: () => payload.tree, set: v => { payload.tree = v; }, floor: 1 },
    // Final fallback: an adversarial collector can make even one element too
    // large, so allow these two to empty completely.
    { get: () => payload.argv, set: v => { payload.argv = v; }, floor: 0 },
    { get: () => payload.tree, set: v => { payload.tree = v; }, floor: 0 },
  ];
  for (const target of shedTargets) {
    if (serializedBytes(payload) <= MAX_EVENT_BYTES) break;
    const original = target.get();
    let low = target.floor;
    let high = original.length;
    while (low < high) {
      const mid = Math.ceil((low + high) / 2);
      target.set(original.slice(0, mid));
      if (serializedBytes(payload) <= MAX_EVENT_BYTES) low = mid;
      else high = mid - 1;
    }
    target.set(original.slice(0, low));
  }
  return payload;
}

function addError(errors, code) {
  if (ERROR_CODES.has(code) && !errors.includes(code)) errors.push(code);
}

function cpuTimeSeconds(value) {
  const match = String(value || '').match(/^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+(?:\.\d+)?)$/);
  if (!match) return 0;
  return (Number(match[1] || 0) * 86400)
    + (Number(match[2] || 0) * 3600)
    + (Number(match[3] || 0) * 60)
    + Number(match[4] || 0);
}

function parseProcessTable(stdout) {
  const rows = [];
  for (const line of String(stdout || '').split(/\r?\n/)) {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(\S+)\s+(.+?)\s*$/);
    if (!match) continue;
    rows.push({
      pid: Number(match[1]),
      ppid: Number(match[2]),
      pgid: Number(match[3]),
      state: match[4],
      cputime_s: cpuTimeSeconds(match[5]),
      exe_basename: match[6],
    });
  }
  return rows;
}

// Index by parent and walk once. The previous fixed-point loop rescanned every
// row per round, so a reversed parent chain made this O(n^2): codex measured a
// 3.08s synchronous stall on an 18k-process table even with timeoutMs=50. The
// collection deadline cannot cover synchronous work, so the work itself must be
// linear — S0 must never delay the kill it precedes.
function descendantsOf(rows, rootPid) {
  const byParent = new Map();
  for (const row of rows) {
    let bucket = byParent.get(row.ppid);
    if (!bucket) { bucket = []; byParent.set(row.ppid, bucket); }
    bucket.push(row);
  }
  const pids = new Set([rootPid]);
  const stack = [rootPid];
  while (stack.length) {
    for (const child of byParent.get(stack.pop()) || []) {
      if (pids.has(child.pid)) continue;
      pids.add(child.pid);
      stack.push(child.pid);
    }
  }
  return rows.filter(row => pids.has(row.pid));
}

function parseCommandLine(value) {
  const text = String(value || '').trim();
  if (!text) return [];
  const tokens = [];
  let token = '';
  let quote = null;
  let escaped = false;
  for (const char of text) {
    if (escaped) { token += char; escaped = false; continue; }
    if (char === '\\' && quote !== "'") { escaped = true; continue; }
    if (quote) {
      if (char === quote) quote = null;
      else token += char;
      continue;
    }
    if (char === '"' || char === "'") { quote = char; continue; }
    if (/\s/.test(char)) {
      if (token) { tokens.push(token); token = ''; }
    } else token += char;
  }
  if (escaped) token += '\\';
  if (token) tokens.push(token);
  return tokens;
}

function withDeadline(promise, deadlineAt) {
  const remaining = Math.max(1, deadlineAt - Date.now());
  let timer;
  return Promise.race([
    Promise.resolve(promise),
    new Promise((_, reject) => {
      timer = setTimeout(() => {
        const error = new Error('snapshot deadline exceeded');
        error.code = 'SNAPSHOT_TIMEOUT';
        reject(error);
      }, remaining);
      timer.unref?.();
    }),
  ]).finally(() => clearTimeout(timer));
}

async function boundedExec(executor, command, args, deadlineAt, maxBuffer = 512 * 1024) {
  if (!executor || typeof executor.exec !== 'function') throw new Error('executor unavailable');
  const timeoutMs = Math.max(1, deadlineAt - Date.now());
  return withDeadline(
    executor.exec(command, args, { timeoutMs, maxBuffer }),
    deadlineAt,
  );
}

function sessionPid(executionEngine, run) {
  if (!executionEngine || typeof executionEngine.listSessions !== 'function') return null;
  try {
    const session = (executionEngine.listSessions() || []).find(item => (
      String(item?.runId || '') === String(run.id)
      || item?.name === run.tmux_session
      || item?.name === `subprocess-${run.id}`
    ));
    return Number.isInteger(session?.pid) && session.pid > 0 ? session.pid : null;
  } catch {
    return null;
  }
}

async function resolveRootPid({ executor, executionEngine, run, deadlineAt }) {
  const direct = sessionPid(executionEngine, run);
  if (direct) return direct;
  const sessionName = run.tmux_session
    || `palantir-run-${String(run.id || '').replace(/[^A-Za-z0-9_-]/g, '_')}`;
  const result = await boundedExec(
    executor,
    'tmux',
    ['display-message', '-p', '-t', sessionName, '#{pane_pid}'],
    deadlineAt,
    4096,
  );
  const pid = Number.parseInt(String(result?.stdout || '').trim(), 10);
  return result?.code === 0 && Number.isInteger(pid) && pid > 0 ? pid : null;
}

async function localProcArgv(pid, deadlineAt) {
  const value = await withDeadline(fsp.readFile(`/proc/${pid}/cmdline`), deadlineAt);
  const clipped = value.length > 64 * 1024;
  return {
    argv: value.subarray(0, 64 * 1024).toString('utf8').split('\0').filter(Boolean),
    clipped,
  };
}

async function psArgv(executor, pid, deadlineAt) {
  const result = await boundedExec(
    executor,
    'ps',
    ['-ww', '-p', String(pid), '-o', 'command='],
    deadlineAt,
    128 * 1024,
  );
  if (result?.code !== 0) throw new Error('ps argv failed');
  return { argv: parseCommandLine(result.stdout), clipped: false };
}

async function localFdSummary(pid, deadlineAt) {
  const entries = await withDeadline(fsp.readdir(`/proc/${pid}/fd`), deadlineAt);
  const summary = { file: 0, socket: 0, pipe: 0, other: 0 };
  const limited = entries.slice(0, 4096);
  for (const entry of limited) {
    const target = await withDeadline(fsp.readlink(`/proc/${pid}/fd/${entry}`), deadlineAt);
    if (target.startsWith('socket:')) summary.socket += 1;
    else if (target.startsWith('pipe:')) summary.pipe += 1;
    else if (target.startsWith('/')) summary.file += 1;
    else summary.other += 1;
  }
  return { summary, clipped: entries.length > limited.length };
}

async function remoteFdSummary(executor, pid, deadlineAt) {
  const result = await boundedExec(
    executor,
    'ls',
    ['-l', `/proc/${pid}/fd`],
    deadlineAt,
    256 * 1024,
  );
  if (result?.code !== 0) throw new Error('remote fd read failed');
  const summary = { file: 0, socket: 0, pipe: 0, other: 0 };
  for (const line of String(result.stdout || '').split(/\r?\n/)) {
    const arrow = line.indexOf(' -> ');
    if (arrow === -1) continue;
    const target = line.slice(arrow + 4);
    if (target.startsWith('socket:')) summary.socket += 1;
    else if (target.startsWith('pipe:')) summary.pipe += 1;
    else if (target.startsWith('/')) summary.file += 1;
    else summary.other += 1;
  }
  return { summary, clipped: false };
}

/**
 * Collect live evidence through the execution-node seam, then immediately
 * serialize it through the fail-closed allowlist. The function itself never
 * throws; operational details become fixed collect_errors codes only.
 */
async function collectWorkerSnapshotUnsafe({
  run = {},
  profile = {},
  executor,
  executionEngine,
  remote = false,
  lastOutputAt = null,
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  const raw = {
    run_id: run.id,
    profile_id: run.agent_profile_id || profile.id,
    node_id: run.node_id || 'local',
    profile,
    argv: [],
    tree: [],
    fd_summary: { file: 0, socket: 0, pipe: 0, other: 0 },
    last_output_at: lastOutputAt,
    collect_errors: [],
    truncated: false,
  };
  const deadlineAt = Date.now() + Math.max(50, Math.min(Number(timeoutMs) || DEFAULT_TIMEOUT_MS, 5000));

  if (!remote && process.platform !== 'linux' && process.platform !== 'darwin') {
    addError(raw.collect_errors, 'unsupported_platform');
    return serializeWorkerSnapshot(raw);
  }

  let rootPid = null;
  try {
    rootPid = await resolveRootPid({ executor, executionEngine, run, deadlineAt });
  } catch (error) {
    addError(raw.collect_errors, remote || error?.code === 'SNAPSHOT_TIMEOUT'
      ? 'remote_timeout'
      : 'ps_failed');
  }

  if (rootPid) {
    try {
      const result = await boundedExec(
        executor,
        'ps',
        ['-axo', 'pid=,ppid=,pgid=,state=,time=,comm='],
        deadlineAt,
      );
      if (result?.code !== 0) throw new Error('ps failed');
      raw.tree = descendantsOf(parseProcessTable(result.stdout), rootPid);
      if (raw.tree.length === 0) addError(raw.collect_errors, 'ps_failed');
    } catch (error) {
      addError(raw.collect_errors, remote && error?.code === 'SNAPSHOT_TIMEOUT'
        ? 'remote_timeout'
        : 'ps_failed');
    }

    try {
      const result = (!remote && process.platform === 'linux')
        ? await localProcArgv(rootPid, deadlineAt)
        : await psArgv(executor, rootPid, deadlineAt);
      raw.argv = result.argv;
      raw.truncated ||= result.clipped;
    } catch (error) {
      addError(raw.collect_errors, remote && error?.code === 'SNAPSHOT_TIMEOUT'
        ? 'remote_timeout'
        : 'proc_unreadable');
    }

    if (!remote && process.platform === 'linux') {
      try {
        const result = await localFdSummary(rootPid, deadlineAt);
        raw.fd_summary = result.summary;
        raw.truncated ||= result.clipped;
      } catch {
        addError(raw.collect_errors, 'proc_unreadable');
      }
    } else if (remote) {
      try {
        const result = await remoteFdSummary(executor, rootPid, deadlineAt);
        raw.fd_summary = result.summary;
        raw.truncated ||= result.clipped;
      } catch (error) {
        addError(raw.collect_errors, error?.code === 'SNAPSHOT_TIMEOUT'
          ? 'remote_timeout'
          : 'proc_unreadable');
      }
    } else {
      addError(raw.collect_errors, 'proc_unreadable');
    }
  } else {
    addError(raw.collect_errors, remote ? 'remote_timeout' : 'proc_unreadable');
  }

  return serializeWorkerSnapshot(raw);
}

async function collectWorkerSnapshot(options = {}) {
  try {
    return await collectWorkerSnapshotUnsafe(options);
  } catch {
    // Last-resort contract boundary: even unexpected getters or serializer
    // defects return a fixed, allowlisted annotation and never escape.
    return {
      run_id: '<invalid-id>',
      profile_id: '<invalid-id>',
      node_id: '<invalid-id>',
      profile: {
        command: 'custom:e3b0c442',
        type: 'other',
        args_template_keys: [],
      },
      argv: [],
      tree: [],
      fd_summary: { file: 0, socket: 0, pipe: 0, other: 0 },
      last_output_at: null,
      collect_errors: ['proc_unreadable'],
    };
  }
}

module.exports = {
  BUILTIN_COMMANDS,
  KNOWN_FLAGS,
  MAX_EVENT_BYTES,
  MAX_TREE_NODES,
  collectWorkerSnapshot,
  serializeWorkerSnapshot,
};
