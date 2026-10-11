'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const net = require('node:net');
const childProcess = require('node:child_process');
const { StringDecoder } = require('node:string_decoder');
const { resolveClaudeBinary } = require('./streamJsonEngine');
const { managedSettingsPresent } = require('./sessionHubActivation');
const { resolveClaudeAuth, CLAUDE_AUTH_KEYS, CLAUDE_PROVIDER_AUTH_ENV_KEYS } = require('./authResolver');
const { assertSpawnAllowed } = require('../utils/spawnGuard');
const { SESSION_HUB_PROMPT, SESSION_HUB_PROMPT_VERSION } = require('./sessionHubPrompt');

const TOOL_NAMES = ['list_sessions', 'search_instructions', 'get_session'];
const fail = (code, status = 409) => Object.assign(new Error(code), { code, status });
const MAX_MESSAGES = 200;
const MAX_BYTES = 1024 * 1024;
const TRANSCRIPT_LIMIT = 8 * 1024 * 1024;
const LINE_LIMIT = 1024 * 1024;
const repoRoot = path.resolve(__dirname, '../..');

function sessionHubArgv(configPath) {
  return ['--print', '--output-format', 'stream-json', '--input-format', 'stream-json', '--verbose',
    '--include-hook-events', '--tools', '', '--setting-sources', '', '--settings', '{"disableAllHooks":true}',
    '--disable-slash-commands', '--strict-mcp-config', '--mcp-config', configPath, '--allowedTools',
    TOOL_NAMES.map(name => `mcp__session_hub__${name}`).join(','), '--permission-mode', 'default',
    '--append-system-prompt', SESSION_HUB_PROMPT];
}

function createSessionHubService(options = {}) {
  const io = options.fs || fsp;
  const env = options.env || process.env;
  const home = options.home || env.HOME || os.homedir();
  const root = path.resolve(options.root || env.PALANTIR_SESSION_HUB_DIR || path.join(home, '.palantir/session-hub'));
  const projects = options.transcriptRoot || path.join(home, '.claude/projects');
  const spawn = options.spawn || ((...args) => childProcess.spawn(...args));
  const kill = options.kill || ((...args) => process.kill(...args));
  const execFile = options.execFile || childProcess.execFile;
  const guard = options.assertSpawnAllowed || assertSpawnAllowed;
  const resolveBinary = options.resolveBinary || resolveClaudeBinary;
  const auth = options.resolveAuth || (() => resolveClaudeAuth());
  const uid = options.uid ?? process.getuid?.();
  const managedPaths = options.managedPaths || [
    '/Library/Application Support/ClaudeCode/', '/Library/Managed Preferences/com.anthropic.claudecode.plist',
    `/Library/Managed Preferences/${os.userInfo().username}/com.anthropic.claudecode.plist`,
    '/etc/claude-code/',
  ];
  const subscribers = new Set();
  let state = 'idle';
  let generation = 0;
  let token = null;
  let disabled = null;
  let error = null;
  let messages = [];
  let child = null;
  let pgid = null;
  let cwd = null;
  let transcriptDir = null;
  let preparation = null;
  let startPromise = null;
  let closePromise = null;
  let clearRequested = false;
  let permanent = false;
  let turn = null;
  let timer = null;
  let mcpLossTimer = null;
  let mcpLossPending = false;
  let stdoutHandler = null;
  let writeQueue = Promise.resolve();
  let socketServer = null;
  let socketDir = null;
  let mcpReady = false;
  let initSeen = false;
  let initSessionId = null;
  let requiresTranscript = false;
  let transcriptVerified = false;
  let transcriptCheck = null;
  let namespaceReady = false;
  const sockets = new Set();
  const configPath = path.join(root, 'mcp.json');
  const ownedPath = path.join(root, 'owned-sessions');

  function snapshot() {
    return { state, generation, error, disabled, turnInProgress: !!turn,
      promptVersion: SESSION_HUB_PROMPT_VERSION, messages: messages.map(row => ({ ...row })) };
  }
  function publish() {
    const value = snapshot();
    for (const subscriber of subscribers) {
      try { subscriber(value); } catch { /* a disconnected subscriber cannot interrupt cleanup */ }
    }
  }
  function append(role, text, extra = {}, notify = true) {
    messages.push({ role, text: String(text), ...extra });
    while (messages.length > MAX_MESSAGES || Buffer.byteLength(JSON.stringify(messages)) > MAX_BYTES) messages.shift();
    if (notify) publish();
  }
  function setError(code) { error = code; append('error', code); }
  async function stat(filename) {
    try { return await io.lstat(filename); }
    catch (err) { if (err.code === 'ENOENT') return null; throw err; }
  }
  async function privateDir(filename) {
    await io.mkdir(filename, { recursive: true, mode: 0o700 });
    const info = await io.lstat(filename);
    if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o777) !== 0o700
      || (uid !== undefined && info.uid !== uid)) throw fail('session_hub_unsafe_storage', 503);
  }
  async function privateFile(filename, data, exclusive = false) {
    const flags = fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_NOFOLLOW
      | (exclusive ? fs.constants.O_EXCL : 0);
    const file = await io.open(filename, flags, 0o600);
    try {
      const info = await file.stat();
      if (!info.isFile() || (info.mode & 0o777) !== 0o600 || (uid !== undefined && info.uid !== uid)) {
        throw fail('session_hub_unsafe_storage', 503);
      }
      await file.truncate(0);
      await file.writeFile(data);
    } finally { await file.close(); }
  }
  async function readPrivate(filename) {
    const info = await stat(filename);
    if (!info) return '';
    if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o777) !== 0o600
      || (uid !== undefined && info.uid !== uid) || info.size > MAX_BYTES) {
      throw fail('session_hub_unsafe_storage', 503);
    }
    const file = await io.open(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try { return await file.readFile('utf8'); } finally { await file.close(); }
  }
  async function namespace() {
    await privateDir(root);
    let id = (await readPrivate(path.join(root, 'id'))).trim();
    if (!id) {
      id = crypto.randomBytes(8).toString('hex');
      await privateFile(path.join(root, 'id'), `${id}\n`, true);
    }
    if (!/^[0-9a-f]{16}$/.test(id)) throw fail('session_hub_unsafe_storage', 503);
    const directory = path.join(root, `cwd-${id}`);
    await privateDir(directory);
    cwd = await io.realpath(directory);
    const realHome = await io.realpath(home);
    const realRepo = await io.realpath(repoRoot);
    if (cwd === realRepo || cwd.startsWith(`${realRepo}${path.sep}`)) throw fail('session_hub_unsafe_cwd', 503);
    for (let ancestor = cwd; ; ancestor = path.dirname(ancestor)) {
      for (const name of ['CLAUDE.md', 'CLAUDE.local.md', '.claude']) {
        if (name === '.claude' && ancestor === realHome) continue;
        if (await stat(path.join(ancestor, name))) throw fail('session_hub_unsafe_cwd', 503);
      }
      if (ancestor === path.dirname(ancestor)) break;
    }
    transcriptDir = path.join(projects, cwd.replace(/[^a-zA-Z0-9]/g, '-'));
    namespaceReady = true;
  }
  async function credentialSocket(gen) {
    socketDir = await io.mkdtemp(path.join(options.tmpDir || os.tmpdir(), 'hub-mcp-'));
    const checkDirectory = async () => {
      const info = await io.lstat(socketDir);
      if (!info.isDirectory() || info.isSymbolicLink() || (uid !== undefined && info.uid !== uid)) {
        throw fail('session_hub_unsafe_storage', 503);
      }
      await io.chmod(socketDir, 0o700);
    };
    await checkDirectory();
    let socketPath = path.join(socketDir, 'broker.sock');
    if (Buffer.byteLength(socketPath) > 100) {
      await io.rm(socketDir, { recursive: true, force: true });
      socketDir = null;
      socketDir = await io.mkdtemp('/tmp/phub-');
      await checkDirectory();
      socketPath = path.join(socketDir, 'broker.sock');
    }
    if (Buffer.byteLength(socketPath) > 100) throw fail('session_hub_socket_path_too_long', 503);
    let checking = false;
    // Same-UID local processes are outside the threat model: they can read observe-snapshots directly.
    // PGID lookup is defense in depth, not authentication of the socket peer or its self-reported PID.
    socketServer = (options.net || net).createServer(socket => {
      if (!live(gen) || mcpReady || checking) return socket.destroy();
      sockets.add(socket);
      let credentialGranted = false;
      let disconnected = false;
      const lost = () => {
        const alreadyDisconnected = disconnected;
        disconnected = true;
        if (alreadyDisconnected || !credentialGranted || !live(gen)) return;
        token = null;
        mcpReady = false;
        mcpLossPending = true;
        // MCP stdin EOF can precede the parent's final stdout/exit. Revoke access now but keep parsing stdout.
        mcpLossTimer = setTimeout(() => {
          if (!live(gen) || !mcpLossPending) return;
          error = 'session_hub_mcp_lost';
          void close().catch(() => {});
          append('error', error);
        }, 2000);
      };
      socket.on('close', () => { sockets.delete(socket); lost(); });
      socket.on('end', lost);
      socket.on('error', lost);
      socket.setTimeout(5000, () => socket.destroy());
      let buffer = '';
      let handled = false;
      socket.on('data', chunk => {
        if (handled) return;
        buffer += chunk.toString('utf8');
        if (buffer.length > 4096) return socket.destroy();
        if (!buffer.includes('\n')) return;
        handled = true;
        let hello;
        try { hello = JSON.parse(buffer.split('\n')[0]); } catch { return socket.destroy(); }
        if (!live(gen) || !token || mcpReady || checking) return socket.destroy();
        if (!Number.isSafeInteger(hello.pid) || hello.pid <= 0) {
          setError('session_hub_unexpected_pgid');
          void close().catch(() => {});
          return socket.destroy();
        }
        checking = true;
        // Detached from cleanup: even a stuck query callback cannot delay close or a later generation.
        void new Promise((resolve, reject) => {
          execFile('/bin/ps', ['-o', 'pgid=', '-p', String(hello.pid)],
            { encoding: 'utf8', timeout: 1000, killSignal: 'SIGKILL', maxBuffer: 1024 }, (err, stdout) => {
              if (err) reject(err);
              else resolve(String(stdout).trim());
            });
        }).then(actual => {
          if (!live(gen) || !token || disconnected || socket.destroyed || mcpReady) return socket.destroy();
          if (!/^[1-9][0-9]*$/.test(actual) || Number(actual) !== pgid) {
            throw fail('session_hub_unexpected_pgid', 503);
          }
          mcpReady = true;
          credentialGranted = true;
          socket.setTimeout(0);
          options.onMcpProcess?.({ pid: hello.pid, pgid: Number(actual), kind: 'mcp' });
          socket.write(`${JSON.stringify({ PALANTIR_SESSION_HUB_TOKEN: token,
            PALANTIR_SESSION_HUB_BASE_URL: getBaseUrl() })}\n`);
          // Keep this one connection as MCP liveness evidence; close only the listener to forbid reconnection.
          socketServer.close(() => {});
        }).catch(() => {
          if (live(gen)) { setError('session_hub_unexpected_pgid'); void close().catch(() => {}); }
          socket.destroy();
        }).finally(() => { checking = false; });
      });
    });
    await new Promise((resolve, reject) => {
      socketServer.once('error', reject);
      socketServer.listen(socketPath, resolve);
    });
    await io.chmod(socketPath, 0o600);
    return socketPath;
  }
  function getBaseUrl() {
    const value = typeof options.baseUrl === 'function' ? options.baseUrl() : options.baseUrl;
    if (!value) throw fail('session_hub_not_listening', 503);
    const url = new URL(value);
    if (url.protocol !== 'http:' || url.username || url.password || url.pathname !== '/') {
      throw fail('session_hub_not_listening', 503);
    }
    return url.origin;
  }
  async function prepare(gen) {
    if (managedSettingsPresent(managedPaths, options.managedFs || fs)) {
      disabled = 'session_hub_managed_settings';
      throw fail(disabled, 503);
    }
    getBaseUrl();
    await namespace();
    await readPrivate(ownedPath);
    const socketPath = await credentialSocket(gen);
    await privateFile(configPath, JSON.stringify({ mcpServers: { session_hub: {
      command: process.execPath,
      args: [path.resolve(__dirname, '../../scripts/session-hub-mcp-bootstrap.cjs'), socketPath],
      env: {},
    } } }));
  }
  function spawnEnv() {
    const result = {};
    for (const key of ['PATH', 'HOME', 'USER', 'LANG', 'TMPDIR']) if (env[key] !== undefined) result[key] = env[key];
    result.HOME = home;
    const authEnv = auth().env || {};
    for (const key of [...CLAUDE_AUTH_KEYS, ...CLAUDE_PROVIDER_AUTH_ENV_KEYS]) {
      if (authEnv[key] !== undefined) result[key] = authEnv[key];
    }
    result.CLAUDE_CODE_DISABLE_AUTO_MEMORY = '1';
    return result;
  }
  function live(gen) { return gen === generation && state === 'running'; }
  function recordOwned(id) {
    if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(id)) {
      throw fail('session_hub_unexpected_paths', 503);
    }
    writeQueue = writeQueue.then(async () => {
      const owned = new Set((await readPrivate(ownedPath)).split('\n').filter(Boolean));
      owned.add(id);
      await privateFile(ownedPath, `${[...owned].join('\n')}\n`);
    });
    writeQueue.catch(() => {
      setError('session_hub_storage_failed');
      void close().catch(() => {});
    });
  }
  function finishTurn(gen) {
    if (!live(gen)) return;
    clearTimeout(timer); timer = null; turn = null; publish();
  }
  function verifyTranscript(gen) {
    if (transcriptCheck) return;
    transcriptCheck = (async () => {
      if (!await safeTranscriptDirectory()) throw fail('session_hub_unexpected_paths', 503);
      const info = await stat(path.join(transcriptDir, `${initSessionId}.jsonl`));
      if (!live(gen)) return;
      if (!info?.isFile() || info.isSymbolicLink()) throw fail('session_hub_unexpected_paths', 503);
      transcriptVerified = true;
      finishTurn(gen);
    })().catch(() => {
      if (!live(gen)) return;
      setError('session_hub_unexpected_paths');
      void close().catch(() => {});
    });
  }
  function protocol(event, gen) {
    if (!live(gen)) return;
    options.onProtocolEvent?.(event);
    if (event.type === 'system' && String(event.subtype).toLowerCase().includes('hook')) {
      disabled = 'session_hub_hooks_detected';
      setError(disabled);
      void close().catch(() => {});
      return;
    }
    if (event.type === 'system' && event.subtype === 'init') {
      try { recordOwned(event.session_id); } catch { setError('session_hub_unexpected_paths'); }
      const hasMemoryPaths = Object.hasOwn(event, 'memory_paths');
      if (error || (hasMemoryPaths && event.memory_paths?.auto !== `${transcriptDir}/memory/`)) {
        setError('session_hub_unexpected_paths');
        void close().catch(() => {});
        return;
      }
      initSessionId = event.session_id;
      requiresTranscript = !hasMemoryPaths;
      initSeen = true;
    }
    if (event.type === 'assistant') {
      for (const block of event.message?.content || []) {
        if (block.type === 'text') append('assistant', block.text);
        if (block.type === 'tool_use') append('tool', JSON.stringify(block.input || {}).slice(0, 1000), {
          name: String(block.name).slice(0, 150),
        });
      }
    }
    if (event.type === 'result') {
      if (event.is_error) append('error', 'session_hub_turn_failed');
      if (requiresTranscript && !transcriptVerified) verifyTranscript(gen);
      else finishTurn(gen);
    }
  }
  function start() {
    if (permanent) return Promise.reject(fail('session_hub_closed'));
    if (state !== 'idle' && state !== 'running') return Promise.reject(fail('session_hub_busy'));
    if (disabled) return Promise.reject(fail(disabled, 503));
    if (state === 'running') return Promise.resolve(snapshot());
    if (state !== 'idle') return Promise.reject(fail('session_hub_busy'));
    state = 'starting'; error = null; clearRequested = false;
    mcpLossPending = false;
    closePromise = null; writeQueue = Promise.resolve(); initSeen = false; mcpReady = false;
    initSessionId = null; requiresTranscript = false; transcriptVerified = false; transcriptCheck = null;
    const gen = ++generation;
    preparation = prepare(gen);
    startPromise = preparation.then(() => {
      if (state !== 'starting' || gen !== generation) return snapshot();
      const binary = resolveBinary();
      if (!binary.executable) throw fail('session_hub_binary_unavailable', 503);
      const argv = sessionHubArgv(configPath);
      const spawnOptions = { detached: true, cwd, env: spawnEnv() };
      token = crypto.randomBytes(32).toString('hex');
      guard({ command: binary.path, source: 'session-hub' });
      child = spawn(binary.path, argv, spawnOptions);
      pgid = child.pid || null;
      state = 'running';
      const decoder = new StringDecoder('utf8');
      let buffer = '';
      stdoutHandler = chunk => {
        if (!live(gen)) return;
        buffer += decoder.write(chunk);
        if (Buffer.byteLength(buffer) > LINE_LIMIT) {
          setError('session_hub_output_too_large'); void close().catch(() => {}); return;
        }
        let newline;
        while ((newline = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
          try { protocol(JSON.parse(line), gen); } catch { /* ignore non-protocol output */ }
        }
      };
      child.stdout.on('data', stdoutHandler);
      child.stderr?.on('data', () => {});
      child.stdin.on('error', () => { if (live(gen)) void close().catch(() => {}); });
      const ended = code => {
        if (gen !== generation) return;
        token = null;
        if (live(gen)) {
          if (code !== 0) setError('session_hub_process_exited');
          void close().catch(() => {});
        }
      };
      child.once('error', () => ended(1));
      child.once('exit', ended);
      publish();
      return snapshot();
    }).catch(async err => {
      token = null;
      if (state === 'starting') {
        setError(err.code || 'session_hub_start_failed');
        await close();
      }
      throw err;
    });
    publish();
    return startPromise;
  }
  function message(text) {
    if (permanent) throw fail('session_hub_closed');
    if (state !== 'running' || mcpLossPending) throw fail('session_hub_not_running');
    if (turn) throw fail('turn_in_progress');
    if (typeof text !== 'string' || !text.trim() || Buffer.byteLength(text) > MAX_BYTES / 2) {
      throw fail('invalid_message', 400);
    }
    const gen = generation;
    turn = { generation: gen };
    append('user', text, {}, false);
    timer = setTimeout(() => {
      if (!live(gen) || !turn) return;
      setError('session_hub_turn_timeout');
      void close().catch(() => {});
    }, options.turnTimeoutMs ?? 180000);
    child.stdin.write(`${JSON.stringify({ type: 'user', message: { role: 'user', content: text } })}\n`);
    publish();
    return snapshot();
  }
  function groupAlive() {
    if (!pgid) return false;
    try { kill(-pgid, 0); return true; }
    catch (err) {
      if (err.code === 'ESRCH') return false;
      // Darwin excludes zombies from killpg: before libuv's waitpid, a zombie-only group yields EPERM.
      // It still exists. Yield to the event loop and require a later ESRCH, never infer successful reaping.
      if (err.code === 'EPERM') return true;
      throw err;
    }
  }
  async function reap() {
    if (!pgid) return;
    const begun = Date.now();
    const termMs = options.termMs ?? 5000;
    const reapMs = options.reapMs ?? 10000;
    let escalated = false;
    const signal = name => {
      try { kill(-pgid, name); }
      catch (err) {
        // A zombie-only group can also deny TERM/KILL. A persistent denial must reach reap_failed.
        if (err.code !== 'ESRCH' && err.code !== 'EPERM') throw err;
      }
    };
    signal('SIGTERM');
    while (groupAlive()) {
      if (Date.now() - begun >= reapMs) throw fail('reap_failed', 503);
      if (!escalated && Date.now() - begun >= termMs) { signal('SIGKILL'); escalated = true; }
      await new Promise(resolve => setTimeout(resolve, options.pollMs ?? 25));
    }
    pgid = null;
  }
  async function removeConfig() {
    // Socket disposal must also run after a ledger/config I/O failure.
    try {
      if (namespaceReady && await stat(root)) {
        await privateDir(root);
        const info = await stat(configPath);
        if (info && info.isFile() && !info.isSymbolicLink()) await io.unlink(configPath);
      }
    } finally {
      for (const socket of sockets) socket.destroy();
      if (socketServer) {
        await new Promise(resolve => socketServer.close(resolve));
        socketServer = null;
      }
      if (socketDir) { await io.rm(socketDir, { recursive: true, force: true }); socketDir = null; }
    }
  }
  async function matchingTranscript(filename, info) {
    if (info.size > TRANSCRIPT_LIMIT) return false;
    const file = await io.open(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
      const actual = await file.stat();
      if (!actual.isFile() || actual.size > TRANSCRIPT_LIMIT) return false;
      // Bounded both by stat and by reads, including a file growing during clear.
      const data = Buffer.alloc(TRANSCRIPT_LIMIT + 1);
      let bytesRead = 0;
      while (bytesRead < data.length) {
        const read = await file.read(data, bytesRead, data.length - bytesRead, bytesRead);
        if (!read.bytesRead) break;
        bytesRead += read.bytesRead;
      }
      if (bytesRead > TRANSCRIPT_LIMIT) return false;
      let found = false;
      for (const line of data.subarray(0, bytesRead).toString('utf8').split('\n')) {
        if (!line.trim()) continue;
        if (Buffer.byteLength(line) > LINE_LIMIT) return false;
        let record;
        try { record = JSON.parse(line); } catch { return false; }
        if (Object.hasOwn(record, 'cwd')) {
          if (record.cwd !== cwd) return false;
          found = true;
        }
      }
      return found;
    } finally { await file.close(); }
  }
  async function residual(filename, info) {
    if (!info.isDirectory() || info.isSymbolicLink()) return 1;
    const names = await io.readdir(filename);
    if (!names.length) { await io.rmdir(filename); return 0; }
    let count = 0;
    for (const name of names) {
      const item = path.join(filename, name);
      const entry = await stat(item);
      if (entry) count += await residual(item, entry);
    }
    if (!count) await io.rmdir(filename);
    return count;
  }
  async function safeTranscriptDirectory() {
    // Both result validation and clear reject symlinks in every component, including projects and its parents.
    for (let parent = transcriptDir; ; parent = path.dirname(parent)) {
      const info = await stat(parent);
      if (info && (!info.isDirectory() || info.isSymbolicLink())) return false;
      if (parent === path.dirname(parent)) return true;
    }
  }
  async function clearFiles() {
    // A clear before the first start also handles prior boots, without spawning.
    if (!namespaceReady) await namespace();
    await privateDir(root);
    const owned = new Set((await readPrivate(ownedPath)).split('\n').filter(Boolean));
    let remaining = 0;
    const safe = await safeTranscriptDirectory();
    if (!safe) remaining = 1;
    const directory = safe ? await stat(transcriptDir) : null;
    const names = directory ? await io.readdir(transcriptDir) : [];
    for (const name of names) {
      const filename = path.join(transcriptDir, name);
      const info = await stat(filename);
      if (!info) continue;
      const id = name.endsWith('.jsonl') ? name.slice(0, -6) : null;
      if (id && info.isFile() && !info.isSymbolicLink()
        && (owned.has(id) || await matchingTranscript(filename, info).catch(() => false))) {
        try { await io.unlink(filename); }
        catch (err) { if (err.code !== 'ENOENT') remaining++; }
      } else remaining += await residual(filename, info);
    }
    for (const id of owned) {
      if (!safe || !/^[A-Za-z0-9_-]{1,128}$/.test(id)) continue;
      if (!await stat(path.join(transcriptDir, `${id}.jsonl`))) owned.delete(id);
    }
    if (safe) await privateFile(ownedPath, owned.size ? `${[...owned].join('\n')}\n` : '');
    if (directory && remaining === 0) await io.rmdir(transcriptDir);
    // Only the fixed namespace's cwd is ours; never follow a replaced symlink.
    const cwdInfo = await stat(cwd);
    if (cwdInfo?.isDirectory() && !cwdInfo.isSymbolicLink()) {
      await io.rm(cwd, { recursive: true, force: true });
    } else if (cwdInfo) remaining++;
    return { result: remaining ? 'incomplete' : 'complete', remaining };
  }
  function close({ clear = false, shutdown = false } = {}) {
    if (shutdown) { permanent = true; state = 'closed'; }
    if (clear) clearRequested = true;
    token = null;
    clearTimeout(mcpLossTimer); mcpLossTimer = null; mcpLossPending = false;
    if (closePromise) return closePromise;
    if (!permanent) state = 'closing';
    clearTimeout(timer); timer = null; turn = null;
    closePromise = (async () => {
      // start's continuation checks state; delayed writes cannot resurrect files.
      await preparation?.catch(() => {});
      try { await reap(); }
      catch {
        error = 'reap_failed';
        if (!permanent) state = 'error:reap_failed';
        publish();
        throw fail('reap_failed', 503);
      }
      if (stdoutHandler && child) child.stdout.removeListener('data', stdoutHandler);
      stdoutHandler = null; child = null;
      await writeQueue.catch(() => {});
      await transcriptCheck;
      await removeConfig();
      let result = { result: 'complete', remaining: 0 };
      if (clearRequested) { messages = []; result = await clearFiles(); }
      if (!permanent) state = 'idle';
      const finished = { ...snapshot(), ...result };
      publish();
      return finished;
    })().catch(err => {
      if (err.code !== 'reap_failed') {
        error ||= 'session_hub_cleanup_failed';
        if (!permanent) state = 'error:cleanup_failed';
        publish();
      }
      throw err;
    });
    publish();
    return closePromise;
  }
  function stop() { return close(); }
  function clear() {
    // A completed stop does not satisfy a subsequent clear.
    if (state === 'idle') closePromise = null;
    return close({ clear: true });
  }
  function shutdown() { return close({ shutdown: true }); }
  return { start, message, stop, close, clear, shutdown, state: snapshot, current: () => token,
    subscribe(fn) { subscribers.add(fn); return () => subscribers.delete(fn); },
    diagnostics: () => ({ cwd, transcriptDir, pgid, initSeen, mcpReady, transcriptVerified }),
  };
}

module.exports = { createSessionHubService, sessionHubArgv, TOOL_NAMES };
