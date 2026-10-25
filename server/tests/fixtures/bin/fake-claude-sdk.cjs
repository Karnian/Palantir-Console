#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { spawn } = require('node:child_process');
const readline = require('node:readline');
let config = {};
try { config = JSON.parse(fs.readFileSync('fake-claude.json', 'utf8')); }
catch (error) { if (error.code !== 'ENOENT') throw error; }
const logPath = path.resolve('fake-claude.log');
const log = data => fs.appendFileSync(logPath, JSON.stringify(data) + '\n');
const send = data => process.stdout.write(JSON.stringify(data) + '\n');
const argv = process.argv.slice(2);
const flag = name => {
  const inline = argv.find(arg => arg.startsWith(`${name}=`));
  if (inline) return inline.slice(name.length + 1);
  const index = argv.indexOf(name);
  return index < 0 ? undefined : argv[index + 1];
};
const sessionId = flag('--resume') || flag('--session-id') || randomUUID();
const capabilities = Object.hasOwn(config, 'capabilities') ? config.capabilities : ['msg_lifecycle_v1', 'interrupt_receipt_v1'];
const account = { email: 'fake@example.test', organization: 'fake', subscriptionType: 'Claude Max', apiProvider: 'firstParty' };
log({ type: 'spawn', pid: process.pid, argv, marker: process.env.PALANTIR_OWNED_INCARNATION,
  palantirKeys: Object.keys(process.env).filter(key => key.startsWith('PALANTIR_')),
  authKeys: Object.keys(process.env).filter(key => /^(ANTHROPIC_|CLAUDE_CODE_USE_|CLAUDE_CODE_OAUTH_TOKEN$)/.test(key)) });
if (config.spawnGrandchild) {
  const child = spawn(process.execPath, ['-e', `
    const fs = require('node:fs');
    fs.appendFileSync(process.argv[1], JSON.stringify({type:'grandchild',pid:process.pid,
      marker:process.env.PALANTIR_OWNED_INCARNATION})+'\\n');
    const owner = Number(process.argv[2]);
    setInterval(()=>{ if (process.ppid !== owner) process.exit(0); }, 100);
  `, logPath, String(process.pid)], { stdio: 'ignore', env: process.env });
  process.on('exit', () => { try { child.kill('SIGKILL'); } catch {} });
  if (!config.ignoreSigterm) process.on('SIGTERM', () => {
    child.once('exit', () => process.exit(0));
    if (!child.kill('SIGKILL')) process.exit(0);
  });
}
if (config.ignoreSigterm) process.on('SIGTERM', () => log({ type: 'sigterm_ignored' }));
const pendingTools = new Map(), active = new Map();
let initialized = false, mergeBatch = [], mergeTimer;
const response = (id, value) => send({ type: 'control_response', response: { subtype: 'success', request_id: id, response: value } });
function lifecycle(uuid, state) {
  if (!config.omitLifecycle) send({ type: 'command_lifecycle', command_uuid: uuid, state, session_id: sessionId });
}
function result(uuids, cancelled = false) {
  send({ type: 'assistant', session_id: sessionId, uuid: randomUUID(), parent_tool_use_id: null,
    message: { role: 'assistant', content: [{ type: 'text', text: 'not retained by adapter' }] } });
  send({ type: 'result', subtype: cancelled ? 'error_during_execution' : 'success', is_error: cancelled,
    errors: cancelled ? ['interrupted'] : undefined, result: cancelled ? undefined : 'ok', num_turns: 1,
    session_id: sessionId, uuid: randomUUID(), user_message_uuid: uuids[0],
    ...(config.singularResult ? {} : { user_message_uuids: uuids }) });
  for (const uuid of uuids) { lifecycle(uuid, cancelled ? 'cancelled' : 'completed'); active.delete(uuid); }
}
function finish(batch) {
  const live = batch.filter(message => active.has(message.uuid));
  if (!live.length) return;
  if (config.merge) {
    result(live.map(message => message.uuid));
    return;
  }
  for (const message of live) {
    const tool = config.tool || (message.message.content === 'tool' ? 'Bash' : message.message.content === 'question' ? 'AskUserQuestion' : null);
    if (!tool) { result([message.uuid]); continue; }
    const id = randomUUID(), toolUseId = `tool_${message.uuid}`;
    const input = config.toolInput || (tool === 'AskUserQuestion' ? { questions: [{ question: 'Which?', header: 'Choice', multiSelect: false,
      options: [{ label: 'A', description: 'First' }, { label: 'B', description: 'Second' }] }] } : { command: 'fake success' });
    if (tool === 'AskUserQuestion' && config.questionCount === 2) {
      input.questions.push({ ...input.questions[0], question: 'Why?' });
    }
    const frame = { type: 'control_request', request_id: id,
      request: { subtype: 'can_use_tool', tool_name: tool, input, tool_use_id: toolUseId } };
    pendingTools.set(id, { message, toolUseId, tool, input, frame, responses: 0, cancelled: !!config.cancelToolRequest });
    log({ type: 'tool_request_sent', request_id: id, tool_use_id: toolUseId, phase: 'initial' });
    send(frame);
    if (config.redeliverToolRequest || config.pendingReplayToolName || config.cancelPendingReplay) {
      send(config.pendingReplayToolName ? { ...frame, request: { ...frame.request, tool_name: config.pendingReplayToolName } } : frame);
      log({ type: 'tool_request_sent', request_id: id, tool_use_id: toolUseId, phase: 'before_response' });
    }
    if (config.cancelToolRequest) {
      send({ type: 'control_cancel_request', request_id: id });
      log({ type: 'tool_cancel_sent', request_id: id, tool_use_id: toolUseId });
      result([message.uuid], true);
    }
  }
}
function user(message) {
  log({ type: 'user', uuid: message.uuid });
  if (config.drop) return;
  active.set(message.uuid, message);
  lifecycle(message.uuid, 'queued');
  lifecycle(message.uuid, 'started');
  if (!initialized) {
    initialized = true;
    send({ type: 'system', subtype: 'init', capabilities,
      apiKeySource: Object.hasOwn(config, 'apiKeySource') ? config.apiKeySource : 'none', session_id: sessionId });
    if (config.rateLimit) send({ type: 'rate_limit_event', rate_limit_info: config.rateLimit, session_id: sessionId, uuid: randomUUID() });
  }
  if (config.merge) {
    mergeBatch.push(message);
    clearTimeout(mergeTimer);
    if (mergeBatch.length >= 2) {
      mergeTimer = setTimeout(() => { const batch = mergeBatch; mergeBatch = []; finish(batch); }, config.delayMs || 40);
    }
  } else setTimeout(() => finish([message]), config.delayMs || 0);
}
function publishToolResult(entry, decision, allowed) {
  const allowDecision = decision?.behavior === 'allow';
  const content = !allowed ? decision?.message || (allowDecision ? 'input_mismatch' : 'denied') : entry.tool === 'AskUserQuestion' ?
    Object.values(decision.updatedInput.answers).join(', ') : 'ok';
  send({ type: 'user', session_id: sessionId, uuid: randomUUID(), parent_tool_use_id: config.parentToolUseId ?? null,
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: entry.toolUseId,
      is_error: !allowed || !!config.toolError, content: config.contentArray ? [{ type: 'text', text: content }] : content }] } });
  result([entry.message.uuid]);
}
const lines = readline.createInterface({ input: process.stdin });
lines.on('line', line => {
  const message = JSON.parse(line);
  if (message.type === 'control_request') {
    const request = message.request;
    if (request.subtype === 'initialize') {
      config = JSON.parse(fs.readFileSync('fake-claude.json', 'utf8'));
      log({ type: 'initialize' });
      if (config.initializationError) {
        send({ type: 'control_response', response: { subtype: 'error', request_id: message.request_id, error: 'fake_initialization_error' } });
        return;
      }
      const initialization = {
        commands: [], agents: [], models: [], output_style: 'default', available_output_styles: [],
        account, pid: process.pid, claude_code_version: '2.1.308', current_permission_mode: 'default',
        remote_control_auto_enable: false, capabilities, ...config.initialization
      };
      if (config.omitAccount) delete initialization.account;
      if (!config.hangInitialize) response(message.request_id, initialization);
      if (config.cancelPendingReplay) {
        for (const [id, entry] of pendingTools) {
          entry.cancelled = true;
          send({ type: 'control_cancel_request', request_id: id });
          log({ type: 'tool_cancel_sent', request_id: id, tool_use_id: entry.toolUseId, phase: 'pending_replay' });
          result([entry.message.uuid], true);
        }
      }
    } else if (request.subtype === 'interrupt') {
      response(message.request_id, config.olderReceipt ? {} : { still_queued: config.stillQueued || [] });
      log({ type: 'interrupt_response', request_id: message.request_id });
      if (!config.noInterruptResult) {
        for (const [id] of pendingTools) send({ type: 'control_cancel_request', request_id: id });
        pendingTools.clear();
        for (const uuid of [...active.keys()]) result([uuid], true);
      }
    } else response(message.request_id, {});
  } else if (message.type === 'user') user(message);
  else if (message.type === 'control_response') {
    const entry = pendingTools.get(message.response.request_id);
    if (!entry) return;
    entry.responses++;
    const decision = message.response.response;
    log({ type: 'permission_response', request_id: message.response.request_id,
      tool_use_id: entry.toolUseId, response_count: entry.responses, decision });
    if (entry.cancelled) return;
    if (entry.responses > 1) {
      if (entry.responses === 2 && config.redeliverToolRequest) {
        publishToolResult(entry, decision, entry.allowed && decision?.behavior === 'allow');
      }
      return;
    }
    if (config.redeliverToolRequest) {
      send(entry.frame);
      log({ type: 'tool_request_sent', request_id: message.response.request_id,
        tool_use_id: entry.toolUseId, phase: 'after_response' });
    } else pendingTools.delete(message.response.request_id);
    const allowDecision = decision?.behavior === 'allow';
    const expectedInput = entry.tool === 'AskUserQuestion' ?
      { ...entry.input, answers: decision?.updatedInput?.answers } : entry.input;
    const inputMatch = JSON.stringify(decision?.updatedInput) === JSON.stringify(expectedInput);
    log({ type: 'tool_response', tool_use_id: entry.toolUseId, updatedInput: decision?.updatedInput, inputMatch });
    if (allowDecision && !inputMatch) log({ type: 'input_mismatch', tool_use_id: entry.toolUseId });
    const allowed = allowDecision && inputMatch;
    if (allowed) log({ type: 'tool', tool_use_id: entry.toolUseId,
      ...(entry.tool === 'AskUserQuestion' ? { answers: decision.updatedInput.answers } : {}) });
    if (config.redeliverToolRequest) { entry.allowed = allowed; return; }
    publishToolResult(entry, decision, allowed);
  }
});
lines.on('close', () => {
  log({ type: 'eof' });
  if (!config.ignoreClose) process.exit(0);
  setInterval(() => {}, 1000);
});
