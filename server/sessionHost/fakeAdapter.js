'use strict';
const { EventEmitter } = require('node:events');

function createFakeAdapter(options = {}) {
  const events = new EventEmitter(), children = new Map(), pending = [], toolSignals = new Map();
  const log = { starts: [], startRequests: [], received: [], executions: [], decisions: [], interrupts: [], closes: [], signals: [] };
  let pid = 1000;
  const emit = (incarnation_id, type, data = {}) => events.emit('event', { incarnation_id, type, ...data });
  const api = {
    events, log, children, pending, toolSignals, options,
    settingsCheck() { return typeof options.settings === 'function' ? options.settings() : options.settings !== false; },
    authCheck() { return typeof options.auth === 'function' ? options.auth() : options.auth !== false; },
    start({ incarnation_id, session_id, resume, claude_session_id }) {
      if (resume === true ? typeof claude_session_id !== 'string' || !claude_session_id : resume !== undefined || claude_session_id !== undefined) throw new Error('invalid_resume_contract');
      log.starts.push(incarnation_id);
      log.startRequests.push({ incarnation_id, session_id, ...(resume ? { resume, claude_session_id } : {}) });
      if (options.spawnError) throw new Error(options.spawnError);
      const identity = { pid: ++pid, startedAt: `fake-${pid}` };
      children.set(incarnation_id, { ...identity, exited: false, session_id });
      options.identityProbe?.register(incarnation_id, identity);
      return { ...identity, claude_session_id: resume ? claude_session_id : `fake-conversation-${session_id}` };
    },
    facts(id, toolUseId) { return { exited: children.get(id)?.exited !== false, aborted: toolSignals.get(`${id}:${toolUseId}`)?.aborted === true }; },
    send(id, uuid, text) {
      log.received.push({ incarnation_id: id, uuid });
      if (options.drop) return;
      pending.push({ id, uuid, text });
      if (!options.late && !options.merge) api.flush();
    },
    flush() {
      const batch = pending.splice(0);
      if (!batch.length) return;
      for (const m of batch) {
        const child = children.get(m.id);
        if (!child.initialized) {
          child.initialized = true;
          emit(m.id, 'system_init', { capabilities: options.capabilities || ['msg_lifecycle_v1', 'interrupt_receipt_v1'], apiKeySource: 'none' });
        }
        if (!options.omitLifecycle) {
          emit(m.id, 'lifecycle', { command_uuid: m.uuid, state: 'queued' });
          emit(m.id, 'lifecycle', { command_uuid: m.uuid, state: 'started' });
        }
      }
      if (options.manual) return;
      for (const m of (options.merge ? batch.slice(0, 1) : batch)) {
        emit(m.id, 'result', { user_message_uuids: options.merge ? batch.map(x => x.uuid) : [m.uuid], is_error: !!options.resultError, subtype: options.resultError ? 'error' : 'success' });
      }
      for (const m of batch) if (!options.omitLifecycle) emit(m.id, 'lifecycle', { command_uuid: m.uuid, state: 'completed' });
    },
    decide(id, toolUseId, decision) {
      log.decisions.push({ incarnation_id: id, tool_use_id: toolUseId });
      if (decision.behavior === 'allow') log.executions.push({ incarnation_id: id, tool_use_id: toolUseId });
      if (!options.manualTools) emit(id, 'tool_result', { tool_use_id: toolUseId,
        is_error: decision.behavior === 'deny' || !!options.toolError,
        content: decision.behavior === 'deny' ? decision.message : decision.behavior === 'answer' ? decision.answer : 'ok' });
    },
    interrupt(id, interruptId) {
      log.interrupts.push(id);
      if (!options.noReceipt) emit(id, 'interrupt_receipt', { interrupt_id: interruptId, still_queued: options.stillQueued || [] });
      if (options.interruptUuid) {
        emit(id, 'result', { user_message_uuids: [options.interruptUuid], is_error: true, subtype: 'error_during_execution' });
        emit(id, 'lifecycle', { command_uuid: options.interruptUuid, state: 'cancelled' });
      }
    },
    close(id) { log.closes.push(id); if (!options.noExit) api.exit(id); },
    signal(id, signal) { log.signals.push({ incarnation_id: id, signal }); if (!options.noExit) api.exit(id); },
    exit(id) {
      if (children.has(id)) children.get(id).exited = true;
      options.identityProbe?.exit(id);
      emit(id, 'child_exit');
    },
    toolRequest(id, toolUseId, name = 'Bash', input = {}) {
      const controller = new AbortController();
      toolSignals.set(`${id}:${toolUseId}`, controller.signal);
      emit(id, 'tool_request', { tool_use_id: toolUseId, name, input, signal: controller.signal });
      return controller;
    },
    emit
  };
  return api;
}
module.exports = { createFakeAdapter };
