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

const { buildAssistantContext } = require('./assistantContext');
const { sanitize } = require('./assistantStore');
const TOOL_NAMES = ['list_sessions', 'search_instructions', 'get_session', 'search_assistant_history'];
const fail = (code, status = 409) => Object.assign(new Error(code), { code, status });
const PRIVATE_BYTES = 1024 * 1024;
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
  const epoch = crypto.randomBytes(16).toString('hex');
  let state = 'idle';
  let version = 0;
  let generation = 0;
  let token = null;
  let disabled = null;
  let error = null;
  const store = options.store;
  if (!store) throw new Error('assistant_store_required');
  store.recover();
  let boundThread = null;
  let transcriptsRemaining = 0;
  let cachedMessages = [];
  let activeThread = store.active();
  let closedComplete = false;
  let cleanupComplete = false;
  let partialTimer = null;
  let contextFresh = true;
  let rotateContext = false;
  let invalidationVersion = 0;
  let memoryProvider = null;
  let mutex = Promise.resolve();
  let transitioning = false;
  const serialize = fn => {
    const result = mutex.then(fn);
    mutex = result.catch(() => {});
    return result;
  };
  let child = null;
  let pgid = null;
  let cwd = null;
  let transcriptDir = null;
  let preparation = null;
  let startPromise = null;
  let closePromise = null;
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
    if (!closedComplete) { activeThread = store.active(); cachedMessages = store.window(activeThread); }
    return { state, epoch, version, generation, error, disabled, turnInProgress: !!turn,
      promptVersion: SESSION_HUB_PROMPT_VERSION, thread_id: activeThread,
      transcripts_remaining: transcriptsRemaining, messages: cachedMessages };
  }
  function publish() {
    version++;
    const value = snapshot();
    for (const subscriber of subscribers) {
      try { subscriber(value); } catch { /* a disconnected subscriber cannot interrupt cleanup */ }
    }
  }
  function append(role, text, extra = {}, notify = true) {
    const id = boundThread || store.active();
    store.append(id, role === 'error' ? 'system_note' : role, text, extra);
    if (notify) publish();
  }
  function commitTurn(status) {
    if (!turn) return;
    store.update(turn.assistant.id, turn.content, status, initSessionId);
    turn.lastCommit = Date.now();
  }
  function setError(code) { error = code; append('system_note', code); }
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
      || (uid !== undefined && info.uid !== uid) || info.size > PRIVATE_BYTES) {
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
    const owner = boundThread;
    writeQueue = writeQueue.then(async () => {
      const owned = new Set((await readPrivate(ownedPath)).split('\n').filter(Boolean));
      owned.add(`${id}\t${owner}`);
      await privateFile(ownedPath, `${[...owned].join('\n')}\n`);
    });
    writeQueue.catch(() => {
      setError('session_hub_storage_failed');
      void close().catch(() => {});
    });
  }
  function finishTurn(gen) {
    if (!live(gen)) return;
    commitTurn(turn?.failed ? 'error' : 'complete');
    clearInterval(partialTimer); partialTimer = null;
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
        if (!turn) continue;
        if (block.type === 'text') {
          turn.content = sanitize(turn.content + String(block.text));
          if (Date.now() - turn.lastCommit >= 2000) { commitTurn('partial'); publish(); }
        }
        if (block.type === 'tool_use') append('tool_note', String(block.name).slice(0, 150), {
          turn_id: turn.user.turn_id, model_session_id: initSessionId,
        });
      }
    }
    if (event.type === 'result') {
      const usage = event.usage || {};
      const input = Number(usage.input_tokens || 0) + Number(usage.cache_read_input_tokens || 0)
        + Number(usage.cache_creation_input_tokens || 0);
      if (input > (options.contextTokenLimit ?? 120000)) rotateContext = true;
      if (event.is_error && turn) { turn.failed = true; turn.content += '\nsession_hub_turn_failed'; }
      if (requiresTranscript && !transcriptVerified) verifyTranscript(gen);
      else finishTurn(gen);
    }
  }
  function start() {
    if (permanent) return Promise.reject(fail('session_hub_closed'));
    if (transitioning) return Promise.reject(fail('session_hub_busy'));
    if (state !== 'idle' && state !== 'running') return Promise.reject(fail('session_hub_busy'));
    if (disabled) return Promise.reject(fail(disabled, 503));
    if (state === 'running') return Promise.resolve(snapshot());
    if (state !== 'idle') return Promise.reject(fail('session_hub_busy'));
    state = 'starting'; error = null;
    boundThread = store.active(); contextFresh = true;
    mcpLossPending = false;
    closePromise = null; cleanupComplete = false; writeQueue = Promise.resolve(); initSeen = false; mcpReady = false;
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
  function message(payload) {
    return serialize(async () => {
      if (permanent) throw fail('session_hub_closed');
      const { thread_id, request_id, text } = payload || {};
      if (typeof text !== 'string' || !text.trim() || Buffer.byteLength(text) > 65536
        || typeof thread_id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(thread_id)
        || typeof request_id !== 'string'
        || !/^[A-Za-z0-9_-]{1,128}$/.test(request_id)) throw fail('invalid_message', 400);
      const prior = store.findRequest(thread_id, request_id);
      if (prior) {
        if (prior.user.content !== store.sanitize(text)) throw fail('request_conflict');
        return { ...snapshot(), ...prior, replayed: true };
      }
      if (store.active() !== thread_id) throw fail('thread_not_active');
      if (transitioning || turn) throw fail('turn_in_progress');
      if (state !== 'running' || mcpLossPending) throw fail('session_hub_not_running');
      if (rotateContext) {
        const invalidation = invalidationVersion;
        await close();
        if (permanent) throw fail('session_hub_closed');
        append('system_note', '맥락을 새로 정리함');
        await start();
        rotateContext = invalidation !== invalidationVersion;
      }
      if (permanent || state !== 'running') throw fail('session_hub_not_running');
      const reserved = store.reserve(payload);
      const gen = generation;
      turn = { ...reserved, generation: gen, content: '', lastCommit: Date.now() - 2000 };
      partialTimer = setInterval(() => {
        if (live(gen) && turn?.generation === gen) { commitTurn('partial'); publish(); }
      }, 2000);
      let content = reserved.user.content;
      try {
        if (contextFresh) {
          content = buildAssistantContext(store, boundThread, reserved.user.seq, memoryProvider) + '\n\n' + content;
          contextFresh = false;
        }
      } catch (err) { await close(); throw err; }
      timer = setTimeout(() => {
        if (!live(gen) || !turn) return;
        setError('session_hub_turn_timeout');
        void close().catch(() => {});
      }, options.turnTimeoutMs ?? 180000);
      try { child.stdin.write(`${JSON.stringify({ type: 'user', message: { role: 'user', content } })}\n`); }
      catch (err) { await close(); throw err; }
      publish();
      return { ...snapshot(), ...reserved };
    });
  }
  function newThread() {
    return serialize(async () => {
      if (permanent) throw fail('session_hub_closed');
      if (turn) throw fail('turn_in_progress');
      transitioning = true;
      if (state === 'idle') closePromise = null;
      try {
        await close();
        if (permanent) throw fail('session_hub_closed');
        const thread = store.newThread();
        boundThread = null; rotateContext = false;
        publish();
        return { ...snapshot(), thread };
      } finally { transitioning = false; }
    });
  }
  function deleteThread(id) {
    return serialize(async () => {
      if (permanent) throw fail('session_hub_closed');
      if (id === store.active()) throw fail('thread_active');
      // Validate before touching files; deletion is limited to ledger entries for this thread.
      store.messages(id, { limit: 1 });
      await writeQueue;
      if (permanent) throw fail('session_hub_closed');
      const result = await cleanupTranscripts({ threadId: id });
      if (permanent) throw fail('session_hub_closed');
      store.delete(id);
      publish();
      return { thread_id: id, ...result };
    });
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
  async function safeTranscriptDirectory() {
    // Both result validation and clear reject symlinks in every component, including projects and its parents.
    for (let parent = transcriptDir; ; parent = path.dirname(parent)) {
      const info = await stat(parent);
      if (info && (!info.isDirectory() || info.isSymbolicLink())) return false;
      if (parent === path.dirname(parent)) return true;
    }
  }
  async function cleanupTranscripts({ threadId, all = false } = {}) {
    if (!namespaceReady && !await stat(root)) return { result: 'complete', remaining: 0 };
    if (!namespaceReady) await namespace();
    await privateDir(root);
    const entries = (await readPrivate(ownedPath)).split('\n').filter(Boolean);
    const retained = [];
    const safe = await safeTranscriptDirectory().catch(() => false);
    let remaining = 0;
    for (const entry of entries) {
      const [id, owner] = entry.split('\t');
      // Unbound legacy IDs are eligible at the next cleanup. Other threads stay untouched.
      if (owner && !all && owner !== threadId) { retained.push(entry); continue; }
      if (!safe || !/^[A-Za-z0-9_-]{1,128}$/.test(id)) {
        retained.push(entry); remaining++; continue;
      }
      const filename = path.join(transcriptDir, `${id}.jsonl`);
      let info;
      try { info = await stat(filename); }
      catch { retained.push(entry); remaining++; continue; }
      if (!info) continue;
      if (!info.isFile() || info.isSymbolicLink()) { retained.push(entry); remaining++; continue; }
      try { await io.unlink(filename); }
      catch (err) { if (err.code !== 'ENOENT') { retained.push(entry); remaining++; } }
    }
    await privateFile(ownedPath, retained.length ? `${retained.join('\n')}\n` : '');
    transcriptsRemaining = retained.length;
    return { result: remaining ? 'incomplete' : 'complete', remaining };
  }
  function close({ shutdown = false } = {}) {
    if (closedComplete && closePromise) return closePromise;
    if (shutdown) { permanent = true; state = 'closed'; }
    token = null;
    clearTimeout(mcpLossTimer); mcpLossTimer = null; mcpLossPending = false;
    if (closePromise) {
      if (shutdown) { publish(); if (cleanupComplete) closedComplete = true; }
      return closePromise;
    }
    if (!permanent) state = 'closing';
    if (turn) {
      turn.content = sanitize(turn.content + '\n' + (error || '응답이 중단됨'));
      commitTurn('error');
    }
    clearInterval(partialTimer); partialTimer = null;
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
      const result = await cleanupTranscripts({ threadId: boundThread });
      if (!permanent) state = 'idle';
      publish();
      const value = { ...snapshot(), ...result };
      cleanupComplete = true;
      closedComplete = permanent;
      return value;
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
  function stop() {
    if (state === 'idle') closePromise = null;
    return close();
  }
  function shutdown() { return close({ shutdown: true }); }
  return { start, message, stop, close, shutdown, newThread, deleteThread,
    listThreads: () => store.list(), messages: (id, query) => store.messages(id, query),
    getMessage: (id, mid) => store.get(id, mid),
    searchHistory: query => store.search(boundThread, query.q, query.limit === undefined ? 10 : Number(query.limit)),
    tokenThread: () => token ? boundThread : null,
    setMemoryProvider(fn) { memoryProvider = fn; },
    invalidateContext() { invalidationVersion++; rotateContext = true; }, state: snapshot, current: () => token,
    subscribe(fn) { subscribers.add(fn); return () => subscribers.delete(fn); },
    diagnostics: () => ({ cwd, transcriptDir, pgid, initSeen, mcpReady, transcriptVerified }),
  };
}

module.exports = { createSessionHubService, sessionHubArgv, TOOL_NAMES };
