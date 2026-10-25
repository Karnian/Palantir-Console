'use strict';
const { EventEmitter } = require('node:events');
const { randomUUID } = require('node:crypto');
const childProcess = require('node:child_process');
const pin = require('./pin');
const { assertSpawnAllowed } = require('../utils/spawnGuard');
const { checkSpawnOptionsSync } = require('./argvCheck');
const { buildChildEnv, assertChildEnv } = require('./spawnEnv');
const { createPsIdentityProbe } = require('./psIdentity');

function failure(code) {
  return Object.assign(new Error(code), { code });
}
function bundledExecutable() {
  return require.resolve(`${pin.executablePackage}/claude`);
}
function inputQueue() {
  const items = [];
  let wake, ended = false;
  return {
    push(value) {
      if (ended) throw failure('incarnation_closed');
      items.push(value);
      wake?.();
    },
    end() { ended = true; wake?.(); },
    async *[Symbol.asyncIterator]() {
      while (true) {
        while (items.length) yield items.shift();
        if (ended) return;
        await new Promise(resolve => { wake = resolve; });
        wake = undefined;
      }
    }
  };
}
function capabilityVerdict({ systemInitCapabilities, sdkVersion, cliVersion, permissionMode } = {}) {
  const verdict = { observe: 'supported', prompt: 'unknown', tool_approval: 'supported', cancel: 'unknown', resume: 'supported' };
  if (sdkVersion !== pin.sdkVersion || cliVersion !== pin.cliVersion || permissionMode !== 'default') {
    return Object.fromEntries(Object.keys(verdict).map(key => [key, 'unsupported']));
  }
  if (systemInitCapabilities !== undefined) {
    const caps = Array.isArray(systemInitCapabilities) ? systemInitCapabilities : [];
    verdict.prompt = caps.includes('msg_lifecycle_v1') ? 'supported' : 'unsupported';
    verdict.cancel = caps.includes('interrupt_receipt_v1') ? 'supported' : 'unsupported';
  }
  return verdict;
}
function createSdkAdapter({ sdk, executablePath = bundledExecutable(), executableSha256 = pin.cliSha256,
  cliVersion = pin.cliVersion, baseEnv = process.env, identityProbe = createPsIdentityProbe({ pinnedPath: executablePath }),
  hashFileSync, spawn = childProcess.spawn, extraArgs, testHooks = {} } = {}) {
  function rootsMatch() {
    const forbidden = ['CLAUDE_CONFIG_DIR', 'CLAUDE_SECURESTORAGE_CONFIG_DIR'];
    return !forbidden.some(key => Object.hasOwn(process.env, key) || Object.hasOwn(baseEnv, key)) &&
      typeof baseEnv.HOME === 'string' && baseEnv.HOME.length > 0 && baseEnv.HOME === process.env.HOME;
  }
  const initialRootsMatch = rootsMatch();
  function assertConfigRoot() {
    if (!initialRootsMatch || !rootsMatch()) throw failure('config_root_mismatch');
  }
  const events = new EventEmitter(), children = new Map();
  const emit = (id, type, data = {}) => events.emit('event', { incarnation_id: id, type, ...data });
  function requireChild(id) {
    const child = children.get(id);
    if (!child) throw failure('incarnation_missing');
    return child;
  }
  function translate(id, message) {
    if (message.type === 'system' && message.subtype === 'init') {
      emit(id, 'system_init', { capabilities: message.capabilities, apiKeySource: message.apiKeySource });
    } else if (message.type === 'command_lifecycle') {
      emit(id, 'lifecycle', { command_uuid: message.command_uuid, state: message.state });
    } else if (message.type === 'result') {
      emit(id, 'result', {
        user_message_uuids: Array.isArray(message.user_message_uuids) ? message.user_message_uuids : [],
        is_error: message.is_error, subtype: message.subtype
      });
    } else if (message.type === 'rate_limit_event') {
      emit(id, 'rate_limit', { rate_limit_info: message.rate_limit_info });
    } else if (message.type === 'user' && Array.isArray(message.message?.content)) {
      for (const block of message.message.content) {
        if (block.type !== 'tool_result') continue;
        const content = typeof block.content === 'string' ? block.content : Array.isArray(block.content) ?
          block.content.filter(item => item.type === 'text' && typeof item.text === 'string').map(item => item.text).join('') : '';
        emit(id, 'tool_result', { tool_use_id: block.tool_use_id, is_error: block.is_error === true, content,
          parent_tool_use_id: message.parent_tool_use_id ?? null });
      }
    }
  }
  const adapter = {
    events,
    checkSettings(cwd) { return Promise.resolve().then(() => { assertConfigRoot(); return sdk.resolveSettings({ cwd }); }); },
    accountInfo(id) {
      return Promise.resolve().then(() => requireChild(id).query.reinitialize()).then(initialization => {
        if (!initialization?.account || typeof initialization.account !== 'object') throw failure('account_unavailable');
        return initialization.account;
      });
    },
    start({ incarnation_id: id, cwd, resume, claude_session_id }) {
      assertConfigRoot();
      if (children.has(id)) throw failure('incarnation_exists');
      if (resume === true ? typeof claude_session_id !== 'string' || !claude_session_id :
        resume !== undefined || claude_session_id !== undefined) throw failure('invalid_resume_contract');
      const sessionId = resume ? claude_session_id : randomUUID();
      const row = { input: inputQueue(), pending: new Map(), signals: new Map(), decided: new Set(), exited: false, closed: false };
      let spawnError;
      function customSpawn(opts) {
        try {
          try { assertSpawnAllowed({ command: opts.command, source: 'sessionHost.sdkAdapter' }); }
          catch { throw failure('spawn_blocked'); }
          const verdict = checkSpawnOptionsSync(opts, { pinnedPath: executablePath, pinnedSha256: executableSha256, hashFileSync });
          if (!verdict.ok) {
            throw failure(verdict.reason === 'executable_check_failed' ? 'executable_mismatch' : verdict.reason);
          }
          const env = buildChildEnv({ baseEnv, sdkEnv: opts.env, incarnationId: id });
          assertChildEnv(env, id);
          row.process = spawn(opts.command, opts.args, {
            cwd: opts.cwd, env, signal: opts.signal, stdio: ['pipe', 'pipe', 'pipe']
          });
          row.process.on('error', () => {});
          row.process.stderr?.resume();
          row.process.once('exit', () => {
            row.exited = true;
            row.input.end();
            identityProbe.exit?.(id);
            emit(id, 'child_exit');
          });
          let identity;
          try { identity = identityProbe.readStartTime(row.process.pid); }
          catch { throw failure('identity_unavailable'); }
          if (identity?.status !== 'ok' || typeof identity.startedAt !== 'string' || !identity.startedAt) {
            throw failure('identity_unavailable');
          }
          row.startedAt = identity.startedAt;
          identityProbe.register?.(id, { pid: row.process.pid, startedAt: row.startedAt });
          return row.process;
        } catch (error) {
          try { row.process?.kill('SIGKILL'); } catch { /* Keep the fixed refusal code. */ }
          const codes = ['executable_mismatch', 'executable_hash_mismatch', 'unsafe_argv', 'invalid_child_env',
            'identity_unavailable', 'spawn_blocked'];
          spawnError = failure(codes.includes(error.code) ? error.code : 'spawn_blocked');
          throw spawnError;
        }
      }
      function canUseTool(name, input, { signal, toolUseID }) {
        const existing = row.pending.get(toolUseID);
        if (existing) return existing.promise;
        if (row.decided.has(toolUseID)) return Promise.resolve({ behavior: 'deny', message: 'duplicate_tool_request' });
        let resolve;
        const promise = new Promise(done => { resolve = done; });
        const pending = { input, promise, settle };
        function settle(result) {
          if (row.pending.get(toolUseID) !== pending) return;
          row.pending.delete(toolUseID);
          row.decided.add(toolUseID);
          signal.removeEventListener('abort', abort);
          resolve(result);
        }
        function abort() { settle({ behavior: 'deny', message: 'request_aborted' }); }
        row.pending.set(toolUseID, pending);
        row.signals.set(toolUseID, signal);
        if (signal.aborted || row.exited || row.closed) { abort(); return promise; }
        signal.addEventListener('abort', abort, { once: true });
        emit(id, 'tool_request', { tool_use_id: toolUseID, name, input, signal });
        return promise;
      }
      try {
        row.query = sdk.query({ prompt: row.input, options: {
          cwd, permissionMode: 'default', pathToClaudeCodeExecutable: executablePath,
          ...(resume ? { resume: sessionId } : { sessionId }), canUseTool, spawnClaudeCodeProcess: customSpawn,
          ...(extraArgs ? { extraArgs } : {})
        } });
        // The pinned SDK calls customSpawn synchronously; preserve that boundary if it ever catches a throw.
        if (spawnError) throw spawnError;
        if (!row.process || !row.startedAt) throw failure('identity_unavailable');
      } catch (error) {
        row.input.end();
        row.query?.close();
        try { row.process?.kill('SIGKILL'); } catch { /* Keep the fixed refusal code. */ }
        throw spawnError || failure('spawn_blocked');
      }
      children.set(id, row);
      testHooks.onQuery?.({ id, query: row.query, canUseTool });
      row.query.initializationResult().then(
        initialization => emit(id, 'initialization', { initialization }),
        () => emit(id, 'initialization_failed', { code: 'initialization_failed' })
      );
      (async () => {
        try { for await (const message of row.query) translate(id, message); }
        catch { /* A stream failure is not process death. */ }
      })();
      return { pid: row.process.pid, startedAt: row.startedAt, claude_session_id: sessionId };
    },
    send(id, uuid, text) {
      const row = requireChild(id);
      if (row.exited || row.closed) throw failure('incarnation_closed');
      row.input.push({ type: 'user', uuid, session_id: '', parent_tool_use_id: null, message: { role: 'user', content: text } });
    },
    decide(id, toolUseId, decision) {
      const row = requireChild(id), pending = row.pending.get(toolUseId);
      if (!pending || row.closed || row.exited) throw failure('tool_request_missing');
      let result;
      if (decision.behavior === 'allow') result = { behavior: 'allow', updatedInput: pending.input };
      else if (decision.behavior === 'deny') result = { behavior: 'deny', message: decision.message };
      else if (decision.behavior === 'answer') {
        const answer = decision.answer, questions = pending.input.questions;
        if (!Array.isArray(questions) || typeof answer === 'string' && questions.length !== 1) {
          throw failure('invalid_decision');
        }
        const answers = typeof answer === 'string' ? { [questions[0].question]: answer } : answer;
        if (!answers || typeof answers !== 'object' || Array.isArray(answers) ||
            !Object.values(answers).every(value => typeof value === 'string' && value.trim().length > 0)) {
          throw failure('invalid_decision');
        }
        const keys = Object.keys(answers), expected = new Set(questions.map(question => question.question));
        if (keys.length !== expected.size || keys.some(key => !expected.has(key))) throw failure('invalid_decision');
        result = { behavior: 'allow', updatedInput: { ...pending.input, answers } };
      } else throw failure('invalid_decision');
      pending.settle(result);
    },
    interrupt(id, interruptId) {
      const row = requireChild(id);
      if (row.exited || row.closed) throw failure('incarnation_closed');
      row.query.interrupt().then(receipt => {
        if (Array.isArray(receipt?.still_queued)) {
          emit(id, 'interrupt_receipt', { interrupt_id: interruptId, still_queued: receipt?.still_queued });
        }
      }, () => {}).finally(() => testHooks.onInterruptSettled?.({ id, interruptId }));
    },
    close(id) {
      const row = requireChild(id);
      row.closed = true;
      row.input.end();
      row.query.close();
    },
    signal(id, sig) {
      const row = requireChild(id);
      return row.exited ? 0 : row.process.kill(sig);
    },
    facts(id, toolUseId) {
      const row = children.get(id);
      return { exited: !row || row.exited, aborted: row?.signals.get(toolUseId)?.aborted === true };
    }
  };
  return adapter;
}
async function loadSdkAdapter(options) {
  const sdk = await import('@anthropic-ai/claude-agent-sdk');
  return createSdkAdapter({ sdk, ...options });
}
module.exports = { loadSdkAdapter, createSdkAdapter, capabilityVerdict, bundledExecutable };
