'use strict';

const { EventEmitter } = require('node:events');
const pin = require('./pin');
const { buildChildEnv, assertChildEnv } = require('./spawnEnv');
const subscription = () => ({ email: 'fake@example.test', organization: 'fake', subscriptionType: 'Claude Max', apiProvider: 'firstParty' });

function createFakeAdapter(options = {}) {
  const events = new EventEmitter();
  const children = new Map();
  const pendingMessages = [];
  const toolSignals = new Map();
  const log = {
    starts: [],
    startRequests: [],
    received: [],
    executions: [],
    decisions: [],
    interrupts: [],
    closes: [],
    signals: []
  };
  let nextPid = 1000;
  const emit = (incarnation_id, type, data = {}) => events.emit('event', {
    incarnation_id,
    type,
    ...data
  });
  function readSettings(cwd) {
    if (options.checkSettings) return options.checkSettings(cwd);
    const allowed = typeof options.settings === 'function' ? options.settings() : options.settings !== false;
    return { effective: allowed ? {} : { apiKeyHelper: 'blocked' }, sources: [], provenance: {} };
  }
  function configuredAccount() {
    const allowed = typeof options.auth === 'function' ? options.auth() : options.auth !== false;
    return Object.hasOwn(options, 'account') ? options.account : (allowed ? subscription() : { ...subscription(), tokenSource: 'env' });
  }
  function readAccount(incarnationId) {
    return options.accountInfo ? options.accountInfo(incarnationId) : configuredAccount();
  }
  const adapter = {
    events,
    log,
    children,
    pending: pendingMessages,
    toolSignals,
    options,
    checkSettings(cwd) {
      if (options.async) return Promise.resolve().then(() => readSettings(cwd));
      return readSettings(cwd);
    },
    accountInfo(incarnationId) {
      if (options.async) return Promise.resolve().then(() => readAccount(incarnationId));
      return readAccount(incarnationId);
    },
    start({
      incarnation_id,
      session_id,
      resume,
      claude_session_id
    }) {
      if (resume === true ? typeof claude_session_id !== 'string' || !claude_session_id : resume !== undefined || claude_session_id !== undefined) {
        throw new Error('invalid_resume_contract');
      }
      const env = buildChildEnv({ baseEnv: options.baseEnv || {}, incarnationId: incarnation_id });
      Object.assign(env, options.injectEnv || {});
      assertChildEnv(env, incarnation_id);
      log.starts.push(incarnation_id);
      log.startRequests.push({
        incarnation_id,
        session_id,
        ...(resume ? {
          resume,
          claude_session_id
        } : {})
      });
      if (options.spawnError) {
        throw new Error(options.spawnError);
      }
      const identity = {
        pid: ++nextPid,
        startedAt: `fake-${nextPid}`
      };
      children.set(incarnation_id, {
        ...identity,
        exited: false,
        session_id
      });
      options.identityProbe?.register(incarnation_id, identity);
      const initialize = () => {
        if (options.initializationFailed) { emit(incarnation_id, 'initialization_failed', { code: 'initialization_failed' }); return; }
        emit(incarnation_id, 'initialization', {
          initialization: {
            account: configuredAccount(),
            pid: identity.pid,
            claude_code_version: pin.cliVersion,
            current_permission_mode: 'default',
            remote_control_auto_enable: false,
            ...options.initialization
          }
        });
      };
      if (!options.noInitialization) {
        if (options.async) queueMicrotask(initialize);
        else initialize();
      }
      return {
        ...identity,
        claude_session_id: resume ? claude_session_id : `fake-conversation-${session_id}`
      };
    },
    facts(incarnationId, toolUseId) {
      return {
        exited: children.get(incarnationId)?.exited !== false,
        aborted: toolSignals.get(`${incarnationId}:${toolUseId}`)?.aborted === true
      };
    },
    send(incarnationId, uuid, text) {
      log.received.push({
        incarnation_id: incarnationId,
        uuid
      });
      if (options.drop) {
        return;
      }
      pendingMessages.push({
        id: incarnationId,
        uuid,
        text
      });
      if (!options.late && !options.merge) {
        adapter.flush();
      }
    },
    flush() {
      const batch = pendingMessages.splice(0);
      if (!batch.length) {
        return;
      }
      for (const message of batch) {
        const child = children.get(message.id);
        if (!child.initialized) {
          child.initialized = true;
          emit(message.id, 'system_init', {
            capabilities: options.capabilities || ['msg_lifecycle_v1', 'interrupt_receipt_v1'],
            apiKeySource: Object.hasOwn(options, 'apiKeySource') ? options.apiKeySource : 'none'
          });
        }
        if (!options.omitLifecycle) {
          emit(message.id, 'lifecycle', {
            command_uuid: message.uuid,
            state: 'queued'
          });
          emit(message.id, 'lifecycle', {
            command_uuid: message.uuid,
            state: 'started'
          });
        }
      }
      if (options.manual) {
        return;
      }
      for (const message of options.merge ? batch.slice(0, 1) : batch) {
        emit(message.id, 'result', {
          user_message_uuids: options.merge ? batch.map(message => message.uuid) : [message.uuid],
          is_error: !!options.resultError,
          subtype: options.resultError ? 'error' : 'success'
        });
      }
      for (const message of batch) {
        if (!options.omitLifecycle) {
          emit(message.id, 'lifecycle', {
            command_uuid: message.uuid,
            state: 'completed'
          });
        }
      }
    },
    decide(incarnationId, toolUseId, decision) {
      log.decisions.push({
        incarnation_id: incarnationId,
        tool_use_id: toolUseId
      });
      if (decision.behavior === 'allow') {
        log.executions.push({
          incarnation_id: incarnationId,
          tool_use_id: toolUseId
        });
      }
      if (!options.manualTools) {
        emit(incarnationId, 'tool_result', {
          tool_use_id: toolUseId,
          is_error: decision.behavior === 'deny' || !!options.toolError,
          content: getDecisionContent(decision)
        });
      }
    },
    interrupt(incarnationId, interruptId) {
      log.interrupts.push(incarnationId);
      if (!options.noReceipt) {
        emit(incarnationId, 'interrupt_receipt', {
          interrupt_id: interruptId,
          still_queued: options.stillQueued || []
        });
      }
      if (options.interruptUuid) {
        emit(incarnationId, 'result', {
          user_message_uuids: [options.interruptUuid],
          is_error: true,
          subtype: 'error_during_execution'
        });
        emit(incarnationId, 'lifecycle', {
          command_uuid: options.interruptUuid,
          state: 'cancelled'
        });
      }
    },
    close(incarnationId) {
      log.closes.push(incarnationId);
      if (!options.noExit) {
        adapter.exit(incarnationId);
      }
    },
    signal(incarnationId, signal) {
      log.signals.push({
        incarnation_id: incarnationId,
        signal
      });
      if (!options.noExit) {
        adapter.exit(incarnationId);
      }
    },
    exit(incarnationId) {
      if (children.has(incarnationId)) {
        children.get(incarnationId).exited = true;
      }
      options.identityProbe?.exit(incarnationId);
      emit(incarnationId, 'child_exit');
    },
    toolRequest(incarnationId, toolUseId, name = 'Bash', input = name === 'AskUserQuestion' ?
      { questions: [{ question: 'Which?' }] } : {}) {
      const controller = new AbortController();
      toolSignals.set(`${incarnationId}:${toolUseId}`, controller.signal);
      emit(incarnationId, 'tool_request', {
        tool_use_id: toolUseId,
        name,
        input,
        signal: controller.signal
      });
      return controller;
    },
    emit
  };
  return adapter;
}

function getDecisionContent(decision) {
  if (decision.behavior === 'deny') {
    return decision.message;
  }
  if (decision.behavior === 'answer') {
    return decision.answer;
  }
  return 'ok';
}
module.exports = {
  createFakeAdapter
};
