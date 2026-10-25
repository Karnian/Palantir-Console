'use strict';

const { randomUUID, createHash } = require('node:crypto');
const authGate = require('./authGate');
const { validateDecision } = require('./decisionValidation');
const pin = require('./pin');
const { capabilityVerdict: evaluateCapabilities } = require('./capability');
const { openStore } = require('./store');
const { SimulatedCrash } = require('./faults');
const {
  getEndedPromptOutcome,
  createToolDecision,
  getCompletedPromptOutcome,
  isToolDecisionObserved,
  getToolResultReason,
  getRecoveredIncarnationState,
  getRecoveredStartResult
} = require('./stateRules');
const { buildHandoffCommand } = require('./handoffCommand');
const CONTROLS = new Set(['start', 'resume', 'stop', 'close', 'handoff', 'delete']);
const KINDS = new Set([...CONTROLS, 'prompt', 'tool_decision', 'question_answer', 'interrupt']);
const DAY = 86400000;
const INTERRUPT_RECEIPT_TIMEOUT_MS = 10000;
const RATE_LIMIT_FIELDS = Object.freeze([
  'status', 'resetsAt', 'rateLimitType', 'overageStatus', 'overageDisabledReason', 'isUsingOverage'
]);

function sanitizeRateLimit(info) {
  if (!info || typeof info !== 'object' || Array.isArray(info)) return {};
  const result = {};
  for (const key of RATE_LIMIT_FIELDS) {
    if (!Object.hasOwn(info, key)) continue;
    const value = info[key];
    if (value === null || typeof value === 'string' || typeof value === 'boolean' ||
        typeof value === 'number' && Number.isFinite(value)) result[key] = value;
  }
  return result;
}


function canonical(value) {
  if (Array.isArray(value)) {
    return value.map(canonical);
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map(propertyName => [propertyName, canonical(value[propertyName])]));
  }
  return value;
}
const hash = value => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');

function utf8Prefix(buffer, limit) {
  let end = Math.min(buffer.length, limit);
  while (end < buffer.length && end > 0 && (buffer[end] & 0xc0) === 0x80) end--;
  return buffer.subarray(0, end).toString('utf8');
}
function snapshotPreview(row, previewBytes = 4096) {
  const result = { ...row };
  for (const [key, value] of Object.entries(row)) {
    if ((key === 'body' || key === 'input') && value == null) {
      result[key + '_bytes'] = 0; result[key + '_truncated'] = false;
    }
    if (typeof value !== 'string') continue;
    const buffer = Buffer.from(value);
    const limit = ['body', 'input'].includes(key) ? previewBytes : 4096;
    const total = row[key + '_bytes'] ?? buffer.length;
    if (key === 'body' || key === 'input' || buffer.length > limit || row[key + '_bytes'] !== undefined) {
      result[key] = utf8Prefix(buffer, limit);
      result[key + '_bytes'] = total;
      result[key + '_truncated'] = Buffer.byteLength(result[key]) < total;
    }
  }
  return result;
}

function createHostCore({
  dbPath,
  adapter,
  identityProbe,
  clock = Date.now,
  hostBootId = randomUUID(),
  faults,
  readHooks,
  snapshotMaxBytes = 8 * 1024 * 1024
} = {}) {
  const now = typeof clock === 'function' ? clock : () => clock.now();
  const store = openStore(dbPath, {
    now,
    faults,
    readHooks
  });
  const database = store.db;
  const queues = new Map();
  const signals = new Map();
  let crashed = false;
  let disposed = false;
  const accounts = new Map();
  const rechecks = new Map();
  const cleanups = new Map();
  const deadlines = new Map();
  const pending = new Set();
  const asyncErrors = [];
  const settingsTimers = new Map();
  let timerSequence = 0;
  function deadlineTimers(deadline) {
    return {
      setTimeout(callback) {
        const id = ++timerSequence;
        // The adapter call and promise assimilation share this original deadline.
        settingsTimers.set(id, { callback, at: deadline });
        return id;
      },
      clearTimeout(id) { settingsTimers.delete(id); }
    };
  }
  // Normalize adapter values in one place; only pending results leave the queue.
  function continueResult(read, sessionId, operation, {
    synchronous = value => value,
    asynchronous = value => Promise.resolve(value).then(synchronous),
    failed = () => ({ ok: false })
  } = {}) {
    const complete = value => {
      if (!disposed && !crashed) enqueue(sessionId, () => operation(value));
    };
    let value;
    let result;
    let asynchronousResult;
    try {
      value = read();
      asynchronousResult = value !== null && value !== undefined && typeof value.then === 'function';
      result = asynchronousResult ? asynchronous(value) : synchronous(value);
    } catch {
      complete(failed());
      return;
    }
    if (!asynchronousResult) {
      complete(result);
      return;
    }
    const task = Promise.resolve(result).then(complete, () => complete(failed()))
      .catch(error => { asyncErrors.push(error); })
      .finally(() => pending.delete(task));
    pending.add(task);
  }
  const getRow = (sql, ...parameters) => database.prepare(sql).get(...parameters);
  const getRows = (sql, ...parameters) => database.prepare(sql).all(...parameters);
  const execute = (sql, ...parameters) => database.prepare(sql).run(...parameters);
  const injectFault = point => {
    try {
      faults?.hit?.(point);
    } catch (error) {
      if (error instanceof SimulatedCrash) {
        crashed = true;
      }
      throw error;
    }
  };
  const writeTransaction = operation => store.write(operation);
  const recordEvent = (sessionId, incarnationId, type, data) => store.event(sessionId, incarnationId, type, data);
  const getIncarnation = id => getRow('SELECT * FROM incarnations WHERE id=?', id);
  const getSession = id => getRow('SELECT * FROM owned_sessions WHERE id=?', id);
  const getLatestIncarnation = id => getRow('SELECT * FROM incarnations WHERE session_id=? ORDER BY rowid DESC LIMIT 1', id);
  const getDelivery = id => getRow('SELECT * FROM deliveries WHERE id=?', id);
  const getControl = key => getRow('SELECT * FROM control_requests WHERE request_key=?', key);

  // §4.1/§4.3: replay must never expose a transition without its durable state.
  function transitionRow(table, key, from, values, sessionId, incarnationId, guard = '') {
    const column = table === 'control_requests' ? 'request_key' : 'id';
    const keys = Object.keys(values);
    const result = execute(
      `UPDATE ${table} SET ${keys.map(propertyName => `${propertyName}=?`).join(',')}` +
        ` WHERE ${column}=? AND state IN (${from.map(() => '?').join(',')}) ${guard}`,
      ...keys.map(propertyName => values[propertyName]),
      key,
      ...from
    );
    if (result.changes) {
      const seq = recordEvent(sessionId, incarnationId, 'transition', {
        table,
        id: key,
        ...values
      });
      if (table === 'deliveries' || table === 'control_requests') {
        execute(`UPDATE ${table} SET seq=?,updated_at=? WHERE ${column}=?`, seq, now(), key);
      }
    }
    return result.changes;
  }
  const transitionDelivery = (delivery, from, values) => transitionRow(
    'deliveries',
    delivery.id,
    from,
    values,
    delivery.session_id,
    delivery.incarnation_id,
    Object.hasOwn(values, 'outcome') ? 'AND outcome IS NULL' : ''
  );
  const transitionIncarnation = (incarnation, from, values) => transitionRow(
    'incarnations',
    incarnation.id,
    from,
    values,
    incarnation.session_id,
    incarnation.id
  );
  const transitionControl = (controlRequest, values) => transitionRow(
    'control_requests',
    controlRequest.request_key,
    ['accepted'],
    values,
    controlRequest.session_id,
    controlRequest.incarnation_id
  );

  function transitionSession(session, values) {
    return transitionRow(
      'owned_sessions',
      session.id,
      [session.state],
      values,
      session.id,
      null
    );
  }

  function transitionToolRequest(toolRequest, from, values, incarnation) {
    return transitionRow(
      'tool_requests',
      toolRequest.id,
      from,
      values,
      incarnation.session_id,
      incarnation.id
    );
  }

  function enqueue(sessionId, operation) {
    if (crashed) {
      throw new SimulatedCrash('core_crashed');
    }
    if (queues.has(sessionId)) {
      queues.get(sessionId).push(operation);
      return;
    }
    const commandQueue = [operation];
    queues.set(sessionId, commandQueue);
    try {
      while (commandQueue.length) {
        commandQueue.shift()();
      }
    } finally {
      queues.delete(sessionId);
    }
  }

  // §4.3: queued prompts have no provider effect and must not block queue draining.
  function isIdle(incarnation) {
    return incarnation?.state === 'alive' && incarnation.host_boot_id === hostBootId && !incarnation.attribution_uncertain &&
      !incarnation.interrupt_unknown && accounts.has(incarnation.id) && !getRow("SELECT id FROM deliveries WHERE incarnation_id=? AND kind='prompt' AND state IN " +
        "('sending','written','provider_observed') AND outcome IS NULL LIMIT 1", incarnation.id);
  }

  function hasPassedGate(incarnation) {
    const gate = getRow("SELECT * FROM control_requests WHERE incarnation_id=? AND kind IN ('start','resume') AND state='done' AND stage='done'", incarnation.id);
    return accounts.has(incarnation.id) && gate && !cleanups.has(gate.request_key);
  }

  function areDescendantsClear(incarnation) {
    if (!incarnation) {
      return true;
    }
    try {
      const probeResult = identityProbe.listMarkedDescendants(incarnation.id);
      return probeResult.status === 'ok' && probeResult.pids.length === 0;
    } catch {
      return false;
    }
  }

  function checkIdentity(incarnation) {
    try {
      return identityProbe.check(incarnation.pid, incarnation.pid_started_at);
    } catch {
      return 'query_failed';
    }
  }

  function markAttributionUncertain(incarnation, permanent = true) {
    // 1 is an irreversible mixed-turn barrier; 2 can be resolved by that UUID's evidence.
    transitionIncarnation(incarnation, ['alive', 'orphaned'], {
      attribution_uncertain: permanent || getIncarnation(incarnation.id).attribution_uncertain === 1 ? 1 : 2
    });
  }

  function resolveAttributionCause(delivery) {
    if (!delivery.attribution_pending) {
      return;
    }
    transitionDelivery(delivery, ['sending', 'written', 'unknown', 'provider_observed', 'completed'], {
      attribution_pending: 0
    });
    const incarnation = getIncarnation(delivery.incarnation_id);
    if (incarnation.attribution_uncertain === 2 && !getRow('SELECT id FROM deliveries WHERE incarnation_id=? AND attribution_pending=1 LIMIT 1',
      incarnation.id)) {
      transitionIncarnation(incarnation, ['alive', 'orphaned'], {
        attribution_uncertain: 0
      });
    }
  }

  function taintDelivery(delivery) {
    // §4.3/§4.5: an ambiguous call can still execute later, unlike a finished tool.
    if (delivery.state === 'unknown' && ['tool_finished', 'tool_finished_error'].includes(delivery.reason)) {
      return;
    }
    transitionDelivery(delivery, ['sending', 'written', 'unknown'], {
      tainted: 1
    });
  }

  function taintPendingDecisions(incarnation) {
    for (const delivery of getRows("SELECT * FROM deliveries WHERE incarnation_id=? AND kind IN ('tool_decision'," +
      "'question_answer') AND state IN ('sending','written','unknown')", incarnation.id)) {
      taintDelivery(delivery);
    }
  }

  function finishIncarnationDeliveries(incarnation) {
    for (const delivery of getRows('SELECT * FROM deliveries WHERE incarnation_id=?', incarnation.id)) {
      if (['sending', 'written'].includes(delivery.state)) {
        transitionDelivery(delivery, ['sending', 'written'], {
          state: 'unknown',
          reason: delivery.outcome === 'errored' ? delivery.reason : 'host_lost'
        });
      }
      if (delivery.state === 'queued') {
        transitionDelivery(delivery, ['queued'], {
          state: 'expired',
          reason: 'incarnation_ended'
        });
      }
      if (delivery.kind === 'prompt' && delivery.outcome === null && ['sending', 'written', 'provider_observed', 'unknown'].includes(delivery.state)) {
        const turnResult = delivery.result_json && JSON.parse(delivery.result_json);
        transitionDelivery(delivery, ['sending', 'written', 'provider_observed', 'unknown'], {
          outcome: getEndedPromptOutcome(turnResult),
          ...(turnResult?.is_error ? {
            reason: turnResult.subtype || null
          } : {})
        });
      }
    }
    for (const toolRequest of getRows("SELECT * FROM tool_requests WHERE incarnation_id=? AND state='pending'", incarnation.id)) {
      transitionToolRequest(toolRequest, ['pending'], {
        state: 'expired'
      }, incarnation);
    }
  }

  function drainPromptQueue(sessionId) {
    const incarnation = getLatestIncarnation(sessionId);
    if (!isIdle(incarnation) || incarnation.close_after_turn) {
      return;
    }
    const delivery = getRow("SELECT * FROM deliveries WHERE incarnation_id=? AND kind='prompt' AND state='queued' " + "ORDER BY rowid LIMIT 1", incarnation.id);
    if (delivery) {
      dispatchDelivery(delivery.id);
    }
  }

  function dispatchDelivery(id, checked = false) {
    let delivery = getDelivery(id);
    let incarnation = getIncarnation(delivery.incarnation_id);
    if (delivery.state !== 'queued') {
      rechecks.delete(id);
      return;
    }
    if (delivery.kind === 'prompt' && incarnation?.state === 'alive' && !isIdle(incarnation) && !incarnation.attribution_uncertain &&
      !incarnation.interrupt_unknown && !incarnation.close_after_turn) {
      return;
    }
    if (delivery.kind === 'prompt' && !checked && isIdle(incarnation)) {
      if (rechecks.has(id) || getRow("SELECT id FROM deliveries WHERE incarnation_id=? AND kind='prompt' AND state='queued' ORDER BY rowid LIMIT 1", incarnation.id)?.id !== id) return;
      const token = { passed: false, turn: incarnation.turn_gen };
      rechecks.set(id, token);
      continueResult(() => adapter.accountInfo(incarnation.id), delivery.session_id, result => {
        token.passed = result.ok && !token.invalidated;
        dispatchDelivery(id, true);
        drainPromptQueue(delivery.session_id);
      }, { synchronous: account => authGate.evaluateAccountRecheck(accounts.get(incarnation.id), account) });
      return;
    }
    let decision;
    writeTransaction(() => {
      const toolRequest = delivery.target_tool_use_id && getRow('SELECT * FROM tool_requests WHERE incarnation_id=? AND tool_use_id=?',
        incarnation?.id, delivery.target_tool_use_id);
      let reason;
      if (!incarnation || incarnation.state !== 'alive' || incarnation.host_boot_id !== hostBootId || getSession(delivery.session_id).state !== 'active') {
        reason = 'not_controllable';
      } else if (delivery.kind === 'prompt' && (!isIdle(incarnation) || incarnation.close_after_turn)) {
        reason = 'not_idle';
      } else if (delivery.kind === 'prompt' && (!rechecks.get(id)?.passed || rechecks.get(id).turn !== incarnation.turn_gen)) {
        reason = 'auth_recheck_failed';
      } else if (['tool_decision', 'question_answer'].includes(delivery.kind) && !hasPassedGate(incarnation)) {
        reason = 'gate_pending';
      } else if (['tool_decision', 'question_answer'].includes(delivery.kind) && toolRequest?.state !== 'pending') {
        reason = 'tool_not_pending';
      }
      if (reason) {
        rechecks.delete(id);
        transitionDelivery(delivery, ['queued'], {
          state: 'rejected',
          reason
        });
        return;
      }
      if (toolRequest) {
        const body = JSON.parse(delivery.body || '{}') || {};
        decision = createToolDecision(delivery, body);
        transitionToolRequest(toolRequest, ['pending'], {
          state: 'decided',
          decision: JSON.stringify(decision),
          answer_delivery_id: delivery.id
        }, incarnation);
      }
      if (delivery.kind === 'prompt') {
        rechecks.delete(id);
        transitionIncarnation(incarnation, ['alive'], {
          turn_gen: incarnation.turn_gen + 1
        });
        delivery.turn_gen = incarnation.turn_gen + 1;
      } else {
        delivery.turn_gen = incarnation.turn_gen;
      }
      transitionDelivery(delivery, ['queued'], {
        state: 'sending',
        turn_gen: delivery.turn_gen
      });
      if (delivery.kind === 'interrupt') {
        taintPendingDecisions(incarnation);
        for (const toolRequest of getRows("SELECT * FROM tool_requests WHERE incarnation_id=? AND state='pending'", incarnation.id)) {
          transitionToolRequest(toolRequest, ['pending'], {
            state: 'cancelled'
          }, incarnation);
        }
      }
    });
    delivery = getDelivery(id);
    if (delivery.state !== 'sending') {
      return;
    }
    if (decision) {
      injectFault('after_decided_commit');
    }
    injectFault('after_sending_commit');
    // §4.5: no await may separate durable intent, live SDK facts, and the effect.
    const facts = adapter.facts(incarnation.id, delivery.target_tool_use_id);
    const signal = signals.get(`${incarnation.id}:${delivery.target_tool_use_id}`);
    if (getIncarnation(incarnation.id).state !== 'alive' || facts.exited || facts.aborted || signal?.aborted) {
      writeTransaction(() => transitionDelivery(delivery, ['sending'], {
        state: 'cancelled',
        reason: 'effect_invalidated'
      }));
      return;
    }
    try {
      if (delivery.kind === 'prompt') {
        adapter.send(incarnation.id, delivery.message_uuid, JSON.parse(delivery.body));
      } else if (delivery.kind === 'interrupt') {
        adapter.interrupt(incarnation.id, delivery.id);
      } else {
        adapter.decide(incarnation.id, delivery.target_tool_use_id, decision);
      }
    } catch (error) {
      if (error instanceof SimulatedCrash) {
        throw error;
      }
      writeTransaction(() => {
        if (transitionDelivery(delivery, ['sending', 'written'], {
          state: 'unknown',
          reason: 'effect_failed',
          attribution_pending: 1
        })) {
          markAttributionUncertain(incarnation, false);
        }
      });
      return;
    }
    injectFault('after_effect_before_written');
    writeTransaction(() => {
      transitionDelivery(delivery, ['sending'], {
        state: 'written'
      });
      if (delivery.kind === 'interrupt') settleTurnInterrupts(incarnation, delivery.turn_gen);
    });
  }

  // Only the bound turn's result proves completion; lifecycle alone preserves the uncertainty barrier.
  function settleTurnInterrupts(incarnation, turnGen) {
    const prompt = getRow("SELECT * FROM deliveries WHERE incarnation_id=? AND kind='prompt' AND turn_gen=?", incarnation.id, turnGen);
    if (!prompt) return false;
    const hasResult = !!prompt.result_json;
    const ended = hasResult || prompt.state === 'completed' || prompt.outcome === 'interrupted';
    if (!ended) return false;
    const interrupts = getRows("SELECT * FROM deliveries WHERE incarnation_id=? AND kind='interrupt' AND turn_gen=? " +
      "AND state IN ('sending','written','provider_observed','unknown')", incarnation.id, turnGen);
    if (!interrupts.length) return true;
    for (const delivery of interrupts) {
      const state = hasResult ? 'completed' : 'unknown';
      const reason = hasResult ? null : 'interrupt_unconfirmed';
      if (delivery.state !== state || delivery.reason !== reason) {
        transitionDelivery(delivery, ['sending', 'written', 'provider_observed', 'unknown'], { state, reason });
      }
      if (hasResult) resolveAttributionCause(delivery);
    }
    const unknown = !!getRow("SELECT id FROM deliveries WHERE incarnation_id=? AND kind='interrupt' AND " +
      "(state='unknown' OR (state='provider_observed' AND reason='interrupt_unconfirmed')) LIMIT 1", incarnation.id);
    const latest = getIncarnation(incarnation.id);
    if (latest.interrupt_unknown !== (unknown ? 1 : 0)) {
      transitionIncarnation(latest, ['alive'], { interrupt_unknown: unknown ? 1 : 0 });
    }
    return true;
  }

  function tick() {
    if (crashed) {
      throw new SimulatedCrash('core_crashed');
    }
    for (const [id, timer] of settingsTimers) {
      if (now() >= timer.at) { settingsTimers.delete(id); timer.callback(); }
    }
    for (const [key, at] of deadlines) {
      if (now() < at) continue;
      const control = getControl(key);
      enqueue(control.session_id, () => {
        const current = getControl(key);
        if (current?.state === 'accepted' && current.stage === 'gating') rejectGate(current, 'initialization_timeout');
      });
    }
    for (const [key] of cleanups) {
      const control = getControl(key);
      enqueue(control.session_id, () => advanceGateCleanup(key));
    }
    writeTransaction(() => {
      for (const delivery of getRows("SELECT * FROM deliveries WHERE kind='interrupt' AND state='written' AND updated_at<=?", now(
        ) - INTERRUPT_RECEIPT_TIMEOUT_MS)) {
        transitionDelivery(delivery, ['written'], {
          state: 'unknown',
          reason: 'interrupt_unconfirmed'
        });
        transitionIncarnation(getIncarnation(delivery.incarnation_id), ['alive'], {
          interrupt_unknown: 1
        });
      }
      // Upgrade live rows left by earlier hosts without waiting for another SDK callback.
      for (const target of getRows("SELECT DISTINCT incarnation_id,turn_gen FROM deliveries WHERE kind='interrupt' AND " +
        "state IN ('sending','written','provider_observed','unknown') AND turn_gen IS NOT NULL")) {
        const incarnation = getIncarnation(target.incarnation_id);
        if (incarnation?.state === 'alive' && incarnation.host_boot_id === hostBootId) {
          settleTurnInterrupts(incarnation, target.turn_gen);
        }
      }
    });
  }

  function finishControlRequest(key) {
    const controlRequest = getControl(key);
    const incarnation = controlRequest.incarnation_id && getIncarnation(controlRequest.incarnation_id);
    if (controlRequest.state !== 'accepted') {
      return;
    }
    if (incarnation && !['exited', 'never_started'].includes(incarnation.state)) {
      return;
    }
    writeTransaction(() => transitionControl(controlRequest, {
      stage: 'exit_confirmed'
    }));
    if (!areDescendantsClear(incarnation)) {
      writeTransaction(() => transitionControl(controlRequest, {
        state: 'blocked',
        reason: 'subprocess_remaining'
      }));
      return;
    }
    writeTransaction(() => {
      transitionControl(controlRequest, {
        stage: 'subprocess_checked'
      });
      if (incarnation) {
        transitionIncarnation(incarnation, ['exited', 'never_started'], {
          end_reason: controlRequest.kind === 'stop' ? 'user_restart' : 'user_stop'
        });
      }
      if (controlRequest.kind !== 'stop') {
        if (controlRequest.kind === 'handoff') {
          const session = getSession(controlRequest.session_id);
          recordEvent(session.id, incarnation?.id || null, 'handoff_ready', {
            command: buildHandoffCommand({ cwd: session.cwd, home: adapter.home,
              executablePath: adapter.executablePath, claudeSessionId: session.claude_session_id })
          });
        }
        transitionSession(getSession(controlRequest.session_id), {
          state: controlRequest.kind === 'handoff' ? 'handed_off' : 'closed'
        });
      }
      transitionControl(controlRequest, {
        state: 'done',
        stage: 'done'
      });
    });
  }

  // §4.6: deleting stays durable until scrubbing and WAL maintenance both finish.
  function deleteSessionData(sessionId) {
    writeTransaction(() => {
      for (const requestAlias of getRows("SELECT a.*,d.state FROM request_aliases a JOIN deliveries d ON d.id=a.target_delivery_id " +
        "WHERE a.session_id=?", sessionId)) {
        execute(
          'INSERT OR REPLACE INTO request_tombstones VALUES(?,?,?,?,?)',
          requestAlias.request_key,
          requestAlias.fingerprint,
          requestAlias.state,
          1,
          now() + 30 * DAY
        );
      }
      execute('DELETE FROM request_aliases WHERE session_id=?', sessionId);
      for (const delivery of getRows('SELECT * FROM deliveries WHERE session_id=?', sessionId)) {
        execute(
          'INSERT OR REPLACE INTO request_tombstones VALUES(?,?,?,?,?)',
          delivery.request_key,
          delivery.fingerprint,
          delivery.state,
          1,
          now() + 30 * DAY
        );
      }
      execute('DELETE FROM events WHERE session_id=?', sessionId);
      execute('DELETE FROM tool_requests WHERE incarnation_id IN (SELECT id FROM incarnations WHERE session_id=?)', sessionId);
      execute('DELETE FROM deliveries WHERE session_id=?', sessionId);
      for (const incarnation of getRows('SELECT * FROM incarnations WHERE session_id=?', sessionId)) {
        transitionIncarnation(incarnation, [incarnation.state], {
          host_boot_id: '',
          pid: null,
          pid_started_at: null,
          sdk_version: null,
          cli_path: null,
          cli_sha256: null,
          account_snapshot: null,
          capabilities: null,
          started_at: null,
          ended_at: null,
          end_reason: null,
          turn_gen: 0,
          attribution_uncertain: 0,
          interrupt_unknown: 0,
          close_after_turn: 0
        });
      }
      transitionSession(getSession(sessionId), {
        cwd: null,
        title: null,
        claude_session_id: null
      });
    });
    try {
      database.pragma('wal_checkpoint(TRUNCATE)');
      database.exec('VACUUM');
      // VACUUM itself writes WAL frames; flush those before declaring deletion.
      database.pragma('wal_checkpoint(TRUNCATE)');
    } catch (error) {
      // Route maintenance failures through the same fail-closed storage latch.
      writeTransaction(() => {
        throw error;
      });
    }
    writeTransaction(() => {
      transitionSession(getSession(sessionId), {
        state: 'deleted'
      });
      for (const controlRequest of getRows("SELECT * FROM control_requests WHERE session_id=? AND kind='delete' AND state='accepted'", sessionId)) {
        transitionControl(controlRequest, {
          stage: 'done',
          state: 'done'
        });
      }
    });
  }

  // §4.4: each effect follows its durable stage so recovery never repeats it.
  function executeControlRequest(key) {
    let controlRequest = getControl(key);
    let incarnation = controlRequest.incarnation_id && getIncarnation(controlRequest.incarnation_id);
    if (controlRequest.state !== 'accepted') {
      return;
    }
    if (controlRequest.kind === 'delete') {
      injectFault('after_deleting_commit');
      deleteSessionData(controlRequest.session_id);
      return;
    }
    if (controlRequest.kind === 'start' || controlRequest.kind === 'resume') {
      if (controlRequest.stage === 'requested') {
        writeTransaction(() => transitionControl(controlRequest, { stage: 'settings_checking' }));
        injectFault('after_settings_checking');
        const cwd = getSession(controlRequest.session_id).cwd;
        const deadline = now() + pin.resolveSettingsDeadlineMs;
        const failedSettings = () => ({ ok: false, reason: 'settings_check_failed' });
        continueResult(() => adapter.checkSettings(cwd), controlRequest.session_id, result => {
          const current = getControl(key);
          if (current.state !== 'accepted' || current.stage !== 'settings_checking') return;
          if (now() >= deadline) result = failedSettings();
          if (!result.ok) {
            writeTransaction(() => {
              recordEvent(current.session_id, current.incarnation_id, 'settings_rejected', result);
              transitionIncarnation(incarnation, ['spawning'], { state: 'never_started' });
              transitionControl(current, { state: 'failed', reason: result.reason === 'settings_auth_override' ? 'settings_rejected' : 'settings_check_failed' });
            });
          } else {
            writeTransaction(() => {
              recordEvent(current.session_id, current.incarnation_id, 'settings_checked', result);
              transitionControl(current, { stage: 'settings_checked' });
            });
            executeControlRequest(key);
          }
        }, {
          synchronous: value => now() >= deadline ? failedSettings() : authGate.evaluateResolvedSettings(value),
          asynchronous: value => {
            const remaining = deadline - now();
            if (remaining <= 0) {
              // Observe even an already rejected promise without giving it extra time.
              Promise.resolve(value).catch(() => {});
              return Promise.resolve(failedSettings());
            }
            return authGate.resolveSettingsChecked(() => value, cwd, {
              deadlineMs: remaining, clock: now, timers: deadlineTimers(deadline)
            });
          },
          failed: failedSettings
        });
        return;
      }
      if (controlRequest.stage !== 'settings_checked') return;
      writeTransaction(() => transitionControl(controlRequest, {
        stage: 'spawn_sent'
      }));
      injectFault('after_spawn_sent_before_spawn');
      let spawnIdentity;
      try {
        spawnIdentity = adapter.start({
          incarnation_id: incarnation.id,
          session_id: controlRequest.session_id,
          cwd: getSession(controlRequest.session_id).cwd,
          ...(controlRequest.kind === 'resume' ? {
            resume: true,
            claude_session_id: getSession(controlRequest.session_id).claude_session_id
          } : {})
        });
      } catch (error) {
        if (error instanceof SimulatedCrash) {
          throw error;
        }
        writeTransaction(() => {
          transitionIncarnation(incarnation, ['spawning'], {
            state: 'never_started'
          });
          transitionControl(controlRequest, {
            state: 'failed',
            reason: error.code === 'invalid_child_env' ? 'invalid_child_env' : 'spawn_failed'
          });
        });
        return;
      }
      injectFault('after_spawn_before_identity');
      writeTransaction(() => {
        transitionIncarnation(incarnation, ['spawning'], {
          state: 'alive',
          pid: spawnIdentity.pid,
          pid_started_at: spawnIdentity.startedAt,
          started_at: now()
        });
        // Owned session ids never stand in for provider conversation identities.
        if (typeof spawnIdentity.claude_session_id === 'string' && spawnIdentity.claude_session_id.length) {
          transitionSession(getSession(controlRequest.session_id), {
            claude_session_id: spawnIdentity.claude_session_id
          });
        }
      });
      writeTransaction(() => transitionControl(controlRequest, { stage: 'gating' }));
      deadlines.set(key, now() + pin.initializationDeadlineMs);
      injectFault('after_gating');
      return;
    }
    if (controlRequest.kind === 'handoff') {
      let reason;
      try {
        if (adapter.verifyExecutable?.() !== true) reason = 'executable_hash_mismatch';
        else {
          const session = getSession(controlRequest.session_id);
          buildHandoffCommand({ cwd: session.cwd, home: adapter.home,
            executablePath: adapter.executablePath, claudeSessionId: session.claude_session_id });
        }
      } catch (error) { reason = error.code || 'executable_hash_mismatch'; }
      if (reason) {
        writeTransaction(() => transitionControl(controlRequest, { state: 'failed', reason }));
        return;
      }
    }
    if (!incarnation || ['exited', 'never_started'].includes(incarnation.state)) {
      finishControlRequest(key);
      return;
    }
    if (incarnation.state === 'orphaned') {
      const verdict = checkIdentity(incarnation);
      if (verdict !== 'match') {
        writeTransaction(() => transitionControl(controlRequest, {
          state: 'failed',
          reason: verdict === 'query_failed' ? 'liveness_unknown' : 'identity_mismatch'
        }));
        return;
      }
      writeTransaction(() => transitionControl(controlRequest, {
        stage: 'signal_sent'
      }));
      injectFault('after_close_sent');
      adapter.signal(incarnation.id, 'SIGTERM');
    } else {
      writeTransaction(() => transitionControl(controlRequest, {
        stage: 'close_sent'
      }));
      injectFault('after_close_sent');
      if (controlRequest.kind === 'handoff') {
        writeTransaction(() => {
          taintPendingDecisions(incarnation);
          for (const toolRequest of getRows("SELECT * FROM tool_requests WHERE incarnation_id=? AND state='pending'", incarnation.id)) {
            transitionToolRequest(toolRequest, ['pending'], {
              state: 'cancelled'
            }, incarnation);
          }
        });
        adapter.interrupt(incarnation.id, controlRequest.request_key);
      }
      if (getIncarnation(incarnation.id).state !== 'exited') {
        adapter.close(incarnation.id);
      }
    }
    finishControlRequest(key);
  }

  function advanceGateCleanup(key) {
    const flow = cleanups.get(key);
    const control = getControl(key);
    if (!flow || control?.state !== 'accepted') return;
    const incarnation = getIncarnation(control.incarnation_id);
    if (incarnation.state === 'exited') { finishGateCleanup(control); return; }
    if (now() < flow.at) return;
    if (flow.signalled) { finishGateCleanup(control); return; }
    writeTransaction(() => transitionControl(control, { stage: 'gate_signal_sent' }));
    flow.signalled = true;
    flow.at = now() + pin.sigtermWaitMs;
    try {
      identityProbe.verifyThenSignal(incarnation.pid, incarnation.pid_started_at, 'SIGTERM');
    } catch {
      // Failed identity/signalling cannot establish death; still await and query.
    }
  }

  function finishGateCleanup(control) {
    if (!cleanups.has(control.request_key) || getControl(control.request_key).state !== 'accepted') return;
    const incarnation = getIncarnation(control.incarnation_id);
    const dead = incarnation.state === 'exited' || checkIdentity(incarnation) === 'mismatch_confirmed';
    const clear = areDescendantsClear(incarnation);
    const verified = dead && clear;
    const flow = cleanups.get(control.request_key);
    writeTransaction(() => {
      finishIncarnationDeliveries(incarnation);
      transitionIncarnation(incarnation, [incarnation.state], { state: verified ? 'exited' : 'liveness_unknown', end_reason: 'gate_rejected' });
      transitionControl(control, { state: 'failed', reason: verified ? (flow?.reason === 'gate_rejected' ? 'gate_rejected_cleaned' : flow?.reason || 'gate_rejected_cleaned') : 'gate_rejected_unverified' });
    });
    cleanups.delete(control.request_key);
    accounts.delete(incarnation.id);
  }

  function rejectGate(control, reason = 'gate_rejected', detail = reason) {
    if (control.state !== 'accepted' || cleanups.has(control.request_key)) return;
    deadlines.delete(control.request_key);
    writeTransaction(() => {
      recordEvent(control.session_id, control.incarnation_id, 'gate_rejected', { reason: detail });
      transitionControl(control, { stage: 'gate_close_sent' });
    });
    cleanups.set(control.request_key, { reason, at: now() + pin.closeWaitMs, signalled: false });
    try {
      Promise.resolve(adapter.close(control.incarnation_id)).catch(() => {});
    } catch {}
    if (getIncarnation(control.incarnation_id).state === 'exited') finishGateCleanup(control);
  }

  function closeForInitFailure(incarnation) {
    const failureReason = incarnation.end_reason === 'auth_source_not_subscription' ? incarnation.end_reason : 'capability_missing';
    if (incarnation.state !== 'alive' || getSession(incarnation.session_id).state !== 'active' || getRow(
      "SELECT request_key FROM control_requests WHERE incarnation_id=? AND reason IN ('capability_missing','auth_source_not_subscription')", incarnation.id) || getRow(
        "SELECT request_key FROM control_requests WHERE session_id=? AND state='accepted'", incarnation.session_id)) {
      return;
    }
    const key = `rk_${now()}_${hash([failureReason, incarnation.id])}`;
    writeTransaction(() => {
      execute(
        "INSERT INTO control_requests(request_key,fingerprint,kind,session_id,incarnation_id,stage," +
          "state,reason,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
        key,
        hash(['close', incarnation.id]),
        'close',
        incarnation.session_id,
        incarnation.id,
        'requested',
        'accepted',
        failureReason,
        now(),
        now()
      );
      recordEvent(incarnation.session_id, incarnation.id, 'control_accepted', {
        request_key: key,
        reason: failureReason
      });
    });
    executeControlRequest(key);
  }

  function requestFingerprint(request) {
    return hash([request.kind, request.session_id || null, request.incarnation_id || null, request.target_tool_use_id || null, hash(
      request.body ?? null), hash(request.cwd ?? null)]);
  }

  function abandonedResult(requestKey) {
    return { request_key: requestKey, state: 'rejected', reason: 'request_abandoned' };
  }

  function keyRejection(requestKey) {
    const match = typeof requestKey === 'string' && /^rk_(\d{1,16})_([a-fA-F0-9]{16,})$/.exec(requestKey);
    if (!match) return { state: 'rejected', reason: 'invalid_request' };
    if (+match[1] < now() - DAY) return { state: 'expired', reason: 'key_expired' };
    if (+match[1] > now() + 300000) return { state: 'rejected', reason: 'key_future' };
    return null;
  }

  function abandon(requestKey) {
    if (crashed) throw new SimulatedCrash('core_crashed');
    if (store.failed) throw new Error('storage_unavailable');
    const invalid = keyRejection(requestKey);
    if (invalid?.reason === 'invalid_request') throw new Error(invalid.reason);
    let result;
    // This transaction is synchronous with submit's acceptance: no await separates the lookup and fence.
    writeTransaction(() => {
      const alias = getRow('SELECT * FROM request_aliases WHERE request_key=?', requestKey);
      const existing = (alias && getDelivery(alias.target_delivery_id))
        || getRow('SELECT * FROM deliveries WHERE request_key=?', requestKey) || getControl(requestKey)
        || getRow('SELECT * FROM request_tombstones WHERE request_key=?', requestKey);
      if (existing) {
        result = { abandoned: false, existing: existing.state === 'abandoned' ? abandonedResult(requestKey) : existing };
        return;
      }
      if (invalid) { result = { invalid: invalid.reason }; return; }
      execute('INSERT INTO request_tombstones VALUES(?,?,?,?,?)', requestKey, '', 'abandoned', 0, now() + 30 * DAY);
      result = { abandoned: true };
    });
    if (result.invalid) throw new Error(result.invalid);
    return result;
  }

  function submit(request) {

    function getLatestRequestResult(result) {
      if (result?.id) {
        return getDelivery(result.id);
      }
      if (result?.request_key) {
        return getControl(result.request_key) || result;
      }
      return result;
    }
    if (crashed) {
      throw new SimulatedCrash('core_crashed');
    }
    if (store.failed) {
      throw new Error('storage_unavailable');
    }
    const fingerprint = requestFingerprint(request);
    const alias = getRow('SELECT * FROM request_aliases WHERE request_key=?', request.request_key);
    if (alias) {
      return alias.fingerprint === fingerprint ? getDelivery(alias.target_delivery_id) : {
        state: 'rejected',
        reason: 'fingerprint_conflict',
        status: 409
      };
    }
    const existing = getRow('SELECT * FROM deliveries WHERE request_key=?', request.request_key) || getControl(request.request_key) || getRow(
      'SELECT * FROM request_tombstones WHERE request_key=?', request.request_key);
    if (existing) {
      if (existing.state === 'abandoned') return abandonedResult(request.request_key);
      if (existing.fingerprint !== fingerprint) {
        return {
          state: 'rejected',
          reason: 'fingerprint_conflict',
          status: 409
        };
      }
      return existing;
    }
    if (!KINDS.has(request.kind)) return { state: 'rejected', reason: 'invalid_request' };
    const invalid = keyRejection(request.request_key);
    if (invalid) return invalid;
    const isControl = CONTROLS.has(request.kind);
    let result;
    const sessionId = request.kind === 'start' ? randomUUID() : request.session_id;
    enqueue(sessionId, () => {
      const tombstone = getRow('SELECT * FROM request_tombstones WHERE request_key=?', request.request_key);
      if (tombstone?.state === 'abandoned') {
        result = abandonedResult(request.request_key);
        return;
      }
      let session = sessionId && getSession(sessionId);
      let incarnation = session && getLatestIncarnation(sessionId);
      let reason;
      if (session && ['deleting', 'deleted'].includes(session.state)) {
        writeTransaction(() => execute(
          'INSERT INTO request_tombstones VALUES(?,?,?,?,?)',
          request.request_key,
          fingerprint,
          'rejected',
          1,
          now() + 30 * DAY
        ));
        result = getRow('SELECT * FROM request_tombstones WHERE request_key=?', request.request_key);
        return;
      }
      if (request.kind !== 'start' && (!session || ['deleting', 'deleted'].includes(session.state))) {
        reason = 'session_unavailable';
      }
      if (isControl) {
        if (!reason && request.kind === 'stop' && session?.state === 'active' && incarnation?.close_after_turn) {
          reason = 'capability_close_pending';
          closeForInitFailure(incarnation);
        }
        if (!reason && getRow("SELECT request_key FROM control_requests WHERE session_id=? AND state='accepted'", sessionId)) {
          reason = 'busy';
        }
        if (!reason && request.kind === 'resume') {
          if (session.state !== 'active') {
            reason = 'session_inactive';
          } else if (!incarnation || !['exited', 'never_started'].includes(incarnation.state)) {
            reason = incarnation?.state === 'liveness_unknown' ? 'liveness_unknown' : 'busy';
          } else if (!areDescendantsClear(incarnation)) {
            reason = 'subprocess_remaining';

          }
        }
        if (!reason && ['stop', 'close', 'handoff'].includes(request.kind)) {
          if (session.state !== 'active') {
            reason = 'session_inactive';
          } else if (incarnation && !['alive', 'orphaned', 'exited', 'never_started'].includes(incarnation.state)) {
            reason = incarnation.state === 'liveness_unknown' ? 'liveness_unknown' : 'busy';
          } else if (request.kind === 'handoff' && (!incarnation || !session.claude_session_id)) {
            reason = 'no_session_id';
          }
        }
        if (!reason && request.kind === 'handoff' && request.incarnation_id !== undefined && request.incarnation_id !== incarnation?.id) {
          reason = 'incarnation_mismatch';
        }
        if (!reason && request.kind === 'delete' && !['closed', 'handed_off'].includes(session.state)) {
          reason = 'session_active';
        }
        const incarnationId = ['start', 'resume'].includes(request.kind) && !reason ? randomUUID() : incarnation?.id || null;
        writeTransaction(() => {
          if (!reason && request.kind === 'start') {
            execute(
              'INSERT INTO owned_sessions VALUES(?,?,?,?,?,?)',
              sessionId,
              request.cwd || null,
              null,
              null,
              'active',
              now()
            );
            recordEvent(sessionId, null, 'session_reserved', {
              id: sessionId
            });
          }
          if (!reason && ['start', 'resume'].includes(request.kind)) {
            execute(
              'INSERT INTO incarnations(id,session_id,host_boot_id,state) VALUES(?,?,?,?)',
              incarnationId,
              sessionId,
              hostBootId,
              'spawning'
            );
            recordEvent(sessionId, incarnationId, 'incarnation_reserved', {
              id: incarnationId
            });
          }
          execute(
            "INSERT INTO control_requests(request_key,fingerprint,kind,session_id,incarnation_id,stage," +
              "state,reason,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
            request.request_key,
            fingerprint,
            request.kind,
            sessionId || null,
            incarnationId,
            'requested',
            reason ? 'rejected' : 'accepted',
            reason || null,
            now(),
            now()
          );
          recordEvent(sessionId, incarnationId, 'control_accepted', {
            request_key: request.request_key,
            state: reason ? 'rejected' : 'accepted'
          });
          if (!reason && request.kind === 'delete') {
            transitionSession(session, {
              state: 'deleting'
            });
          }
        });
        if (!reason) {
          injectFault('after_control_accept_before_reply');
          executeControlRequest(request.request_key);
        }
        result = getControl(request.request_key);
      } else {
        if (!reason && (session.state !== 'active' || !incarnation || request.incarnation_id !== incarnation.id)) {
          reason = 'incarnation_mismatch';
        }
        if (!reason && ['question_answer', 'tool_decision'].includes(request.kind)) {
          const tool = getRow('SELECT * FROM tool_requests WHERE incarnation_id=? AND tool_use_id=?',
            incarnation.id, request.target_tool_use_id || null);
          const decision = request.kind === 'question_answer' ?
            { behavior: 'answer', answer: request.body?.answer ?? request.body } : request.body;
          // Validate before creating a delivery or consuming the pending card.
          if (tool?.state === 'pending' && !validateDecision(JSON.parse(tool.input), decision, request.kind).ok) {
            result = { state: 'rejected', reason: request.kind === 'question_answer' ? 'invalid_answer' : 'invalid_decision' };
            return;
          }
        }
        if (!reason && request.kind === 'interrupt') {
          for (const [id, token] of rechecks) {
            const queued = getDelivery(id);
            if (queued?.incarnation_id !== incarnation.id || queued.state !== 'queued') continue;
            token.invalidated = true;
            writeTransaction(() => transitionDelivery(queued, ['queued'], { state: 'rejected', reason: 'auth_recheck_failed' }));
          }
          const pending = getRow("SELECT * FROM deliveries WHERE incarnation_id=? AND turn_gen=? AND kind='interrupt' AND state IN " +
            "('queued','sending','written','provider_observed','unknown') ORDER BY rowid DESC LIMIT 1", incarnation.id, incarnation.turn_gen);
          if (pending) {
            writeTransaction(() => {
              execute(
                'INSERT INTO request_aliases VALUES(?,?,?,?,?)',
                request.request_key,
                fingerprint,
                pending.id,
                sessionId,
                now()
              );
              recordEvent(sessionId, incarnation.id, 'request_alias', {
                request_key: request.request_key,
                target_delivery_id: pending.id
              });
            });
            result = pending;
            return;
          }
        }
        const id = randomUUID();
        writeTransaction(() => {
          execute(
            "INSERT INTO deliveries(id,session_id,incarnation_id,kind,body,target_tool_use_id," +
              "request_key,fingerprint,message_uuid,state,reason,created_at,updated_at) VALUES(?,?,?,?,?," + "?,?,?,?,?,?,?,?)",
            id,
            sessionId || '',
            request.incarnation_id || null,
            request.kind,
            JSON.stringify(request.body ?? null),
            request.target_tool_use_id || null,
            request.request_key,
            fingerprint,
            randomUUID(),
            reason ? 'rejected' : 'queued',
            reason || null,
            now(),
            now()
          );
          recordEvent(sessionId, request.incarnation_id, 'delivery_accepted', {
            id,
            state: reason ? 'rejected' : 'queued'
          });
        });
        if (!reason) {
          dispatchDelivery(id);
        }
        result = getDelivery(id);
      }
    });
    injectFault('before_accepted_reply');
    // Synchronous callbacks may have advanced the row while the queue drained.
    return getLatestRequestResult(result) || {
      state: 'accepted',
      request_key: request.request_key
    };
  }

  function onEvent(adapterEvent) {
    if (crashed || store.failed) {
      return;
    }
    if (adapterEvent.type === 'rate_limit') {
      adapterEvent = {
        type: 'rate_limit',
        incarnation_id: adapterEvent.incarnation_id,
        rate_limit_info: sanitizeRateLimit(adapterEvent.rate_limit_info)
      };
    }
    const incarnation = getIncarnation(adapterEvent.incarnation_id);
    if (!incarnation || ['deleting', 'deleted'].includes(getSession(incarnation.session_id)?.state)) {
      return;
    }
    if (adapterEvent.type === 'sdk_message') {
      enqueue(incarnation.session_id, () => writeTransaction(() =>
        recordEvent(incarnation.session_id, incarnation.id, 'sdk_message', { message: adapterEvent.message })));
      return;
    }
    if (['initialization', 'initialization_failed'].includes(adapterEvent.type)) {
      enqueue(incarnation.session_id, () => {
        const control = getRow("SELECT * FROM control_requests WHERE incarnation_id=? AND state='accepted' AND stage='gating'", incarnation.id);
        if (!control) return;
        if (getIncarnation(incarnation.id).state !== 'alive') { rejectGate(control, 'initialization_failed'); return; }
        if (now() >= deadlines.get(control.request_key)) { rejectGate(control, 'initialization_timeout'); return; }
        const init = adapterEvent.initialization || adapterEvent;
        const result = adapterEvent.type === 'initialization_failed' ? { ok: false, reason: 'initialization_failed' } :
          authGate.evaluateInitialization(init, { expectedPid: getIncarnation(incarnation.id).pid, pin });
        if (!result.ok) { rejectGate(control, result.reason === 'initialization_failed' ? result.reason : 'gate_rejected', result.reason); return; }
        const account = structuredClone(init.account);
        accounts.set(incarnation.id, account);
        deadlines.delete(control.request_key);
        writeTransaction(() => {
          transitionIncarnation(incarnation, ['alive'], { account_snapshot: JSON.stringify({ subscriptionType: account.subscriptionType, apiProvider: account.apiProvider }) });
          transitionControl(control, { state: 'done', stage: 'done' });
        });
        drainPromptQueue(incarnation.session_id);
      });
      return;
    }
    // §4.5: exit and abort must invalidate effects even while a command owns the queue.
    if (adapterEvent.type === 'child_exit' || adapterEvent.type === 'signal_abort') {
      invalidatePendingEffects(adapterEvent, incarnation);
    }
    enqueue(incarnation.session_id, () => {
      let capabilityTurnEnded = false;
      writeTransaction(() => {
        const {
          signal,
          ...raw
        } = adapterEvent;
        recordEvent(incarnation.session_id, incarnation.id, 'sdk', raw);
        if (adapterEvent.type === 'rate_limit') {
          recordEvent(incarnation.session_id, incarnation.id, 'rate_limit', adapterEvent.rate_limit_info);
        }
        if (adapterEvent.type === 'tool_request') {
          if (getIncarnation(incarnation.id).state !== 'alive') {
            return;
          }
          execute(
            'INSERT OR IGNORE INTO tool_requests VALUES(?,?,?,?,?,?,?,?)',
            randomUUID(),
            incarnation.id,
            adapterEvent.tool_use_id,
            adapterEvent.name,
            JSON.stringify(adapterEvent.input),
            adapterEvent.signal?.aborted ? 'cancelled' : 'pending',
            null,
            null
          );
          recordEvent(incarnation.session_id, incarnation.id, 'tool_pending', {
            tool_use_id: adapterEvent.tool_use_id
          });
          if (adapterEvent.signal) {
            signals.set(`${incarnation.id}:${adapterEvent.tool_use_id}`, adapterEvent.signal);
            adapterEvent.signal.addEventListener('abort', () => onEvent({
              incarnation_id: incarnation.id,
              type: 'signal_abort',
              tool_use_id: adapterEvent.tool_use_id
            }), {
              once: true
            });
          }
        } else if (adapterEvent.type === 'lifecycle') {
          const delivery = getRow("SELECT * FROM deliveries WHERE incarnation_id=? AND kind='prompt' AND message_uuid=?", incarnation.id,
            adapterEvent.command_uuid);
          if (delivery && ['completed', 'cancelled'].includes(adapterEvent.state)) {
            capabilityTurnEnded = true;
          }
          if (!delivery || delivery.outcome !== null || getIncarnation(incarnation.id).attribution_uncertain === 1) {
            return;
          }
          if (['queued', 'started', 'completed', 'cancelled'].includes(adapterEvent.state)) {
            resolveAttributionCause(delivery);
          }
          if (['queued', 'started'].includes(adapterEvent.state)) {
            transitionDelivery(delivery, ['sending', 'written', 'unknown'], {
              state: 'provider_observed'
            });
          }
          if (adapterEvent.state === 'completed') {
            const turnResult = delivery.result_json && JSON.parse(delivery.result_json);
            transitionDelivery(delivery, ['sending', 'written', 'provider_observed', 'unknown'], {
              state: 'completed',
              outcome: getCompletedPromptOutcome(turnResult),
              ...(turnResult?.is_error ? {
                reason: turnResult.subtype || null
              } : {})
            });
          }
          if (adapterEvent.state === 'cancelled') {
            transitionDelivery(delivery, ['sending', 'written', 'provider_observed', 'unknown'], {
              state: 'provider_observed',
              outcome: 'interrupted'
            });
          }
          if (['completed', 'cancelled'].includes(adapterEvent.state)) settleTurnInterrupts(incarnation, delivery.turn_gen);
        } else if (adapterEvent.type === 'result') {
          const uuids = adapterEvent.user_message_uuids || [];
          if (uuids.length !== 1) {
            if (uuids.length > 1) {
              markAttributionUncertain(incarnation);
            }
            return;
          }
          const delivery = getRow("SELECT * FROM deliveries WHERE incarnation_id=? AND kind='prompt' AND message_uuid=?", incarnation.id, uuids[0]);
          if (delivery) {
            capabilityTurnEnded = true;
          }
          if (!delivery || getIncarnation(incarnation.id).attribution_uncertain === 1) {
            return;
          }
          transitionDelivery(delivery, ['sending', 'written', 'provider_observed', 'unknown', 'completed'], {
            result_json: JSON.stringify(adapterEvent)
          });
          settleTurnInterrupts(incarnation, delivery.turn_gen);
        } else if (adapterEvent.type === 'tool_result') {
          const toolRequest = getRow('SELECT * FROM tool_requests WHERE incarnation_id=? AND tool_use_id=?', incarnation.id, adapterEvent.tool_use_id);
          if (!toolRequest?.answer_delivery_id) {
            return;
          }
          const delivery = getDelivery(toolRequest.answer_delivery_id);
          const decision = JSON.parse(toolRequest.decision);
          const observed = isToolDecisionObserved(delivery, decision, adapterEvent);
          transitionDelivery(delivery, ['sending', 'written', 'unknown'], {
            state: observed ? 'provider_observed' : 'unknown',
            reason: delivery.reason === 'effect_failed' && adapterEvent.is_error && adapterEvent.content === 'invalid_decision' ?
              'effect_failed' : getToolResultReason(observed, adapterEvent)
          });
          // This exact tool has finished, so an ambiguous call cannot execute later.
          resolveAttributionCause(delivery);
        } else if (adapterEvent.type === 'interrupt_receipt') {
          const delivery = getRow("SELECT * FROM deliveries WHERE incarnation_id=? AND kind='interrupt' AND id=?", incarnation.id,
            adapterEvent.interrupt_id || null);
          if (!delivery || !['sending', 'written', 'unknown', 'provider_observed', 'completed'].includes(delivery.state)) {
            return;
          }
          const settled = delivery.state === 'completed' || settleTurnInterrupts(incarnation, delivery.turn_gen);
          if (!settled) {
            if (delivery.state === 'written' && delivery.updated_at <= now() - INTERRUPT_RECEIPT_TIMEOUT_MS) {
              transitionIncarnation(incarnation, ['alive'], { interrupt_unknown: 1 });
            }
            transitionDelivery(delivery, ['sending', 'written', 'unknown'], { state: 'provider_observed' });
            resolveAttributionCause(delivery);
          }
          // A late receipt cannot revive a settled delivery, but survivor evidence remains a permanent barrier.
          if (adapterEvent.still_queued?.length) {
            markAttributionUncertain(incarnation);
            for (const uuid of adapterEvent.still_queued) {
              const survivorDelivery = getRow('SELECT * FROM deliveries WHERE incarnation_id=? AND message_uuid=?', incarnation.id, uuid);
              if (survivorDelivery) {
                transitionDelivery(survivorDelivery, ['sending', 'written', 'unknown'], {
                  state: 'provider_observed'
                });
              }
            }
          }
        } else if (adapterEvent.type === 'system_init') {
          if (getIncarnation(incarnation.id).capabilities !== null) {
            return;
          }
          const verdict = authGate.evaluateSystemInit({ ...adapterEvent, type: 'system', subtype: 'init' });
          transitionIncarnation(incarnation, ['alive'], {
            capabilities: JSON.stringify(adapterEvent.capabilities || []),
            close_after_turn: verdict.ok ? 0 : 1,
            ...(!verdict.ok ? { end_reason: verdict.reason } : {})
          });
          if (!verdict.ok && verdict.reason === 'auth_source_not_subscription') {
            for (const delivery of getRows("SELECT * FROM deliveries WHERE incarnation_id=? AND kind='prompt' AND outcome IS NULL AND state IN ('sending','written','provider_observed')", incarnation.id)) {
              transitionDelivery(delivery, [delivery.state], { outcome: 'errored', reason: verdict.reason });
            }
            capabilityTurnEnded = true;
          }
        } else if (adapterEvent.type === 'child_exit') {
          finishIncarnationDeliveries(getIncarnation(incarnation.id));
        }
      });
      if (adapterEvent.type === 'child_exit') {
        for (const [key] of cleanups) {
          const control = getControl(key);
          if (control.incarnation_id === incarnation.id) finishGateCleanup(control);
        }
        for (const control of getRows("SELECT * FROM control_requests WHERE incarnation_id=? AND state='accepted' AND stage='gating'", incarnation.id)) {
          rejectGate(control, 'initialization_failed');
        }
        for (const controlRequest of getRows("SELECT * FROM control_requests WHERE incarnation_id=? AND state='accepted' AND kind IN " +
          "('stop','close','handoff')", incarnation.id)) {
          finishControlRequest(controlRequest.request_key);
        }
      }
      const current = getIncarnation(incarnation.id);
      if (current?.state === 'alive' && current.close_after_turn && (capabilityTurnEnded || isIdle(current))) {
        closeForInitFailure(current);
      } else {
        drainPromptQueue(incarnation.session_id);
      }
    });
  }

  function invalidatePendingEffects(adapterEvent, incarnation) {
    writeTransaction(() => {
      if (adapterEvent.type === 'child_exit') {
        transitionIncarnation(incarnation, ['spawning', 'alive', 'orphaned', 'liveness_unknown'], {
          state: 'exited',
          ended_at: now()
        });
        accounts.delete(incarnation.id);
        taintPendingDecisions(incarnation);
      } else {
        const toolRequest = getRow('SELECT * FROM tool_requests WHERE incarnation_id=? AND tool_use_id=?', incarnation.id, adapterEvent.tool_use_id);
        if (!toolRequest) {
          return;
        }
        const delivery = toolRequest.answer_delivery_id && getDelivery(toolRequest.answer_delivery_id);
        if (toolRequest.state === 'pending' || toolRequest.state === 'decided' && delivery?.state === 'queued') {
          transitionToolRequest(toolRequest, ['pending', 'decided'], {
            state: 'cancelled'
          }, incarnation);
          if (delivery) {
            transitionDelivery(delivery, ['queued'], {
              state: 'cancelled',
              reason: 'signal_abort'
            });
          }
        } else if (delivery) {
          taintDelivery(delivery);
          recordEvent(incarnation.session_id, incarnation.id, 'decision_tool_aborted', {
            delivery_id: delivery.id
          });
        }
      }
    });
  }

  // §3.3: a failed identity query cannot serve as evidence of process death.
  function recover() {
    if (crashed) {
      throw new SimulatedCrash('core_crashed');
    }
    for (let incarnation of getRows("SELECT * FROM incarnations WHERE state IN ('spawning','alive','orphaned','liveness_unknown')")) {
      let verdict;
      if (getRow("SELECT request_key FROM control_requests WHERE incarnation_id=? AND state='accepted' AND stage IN ('requested','settings_checking','settings_checked')", incarnation.id)) {
        verdict = 'never_started';
      } else if (!incarnation.pid) {
        let found;
        try {
          found = identityProbe.findMarked(incarnation.id);
        } catch {
          found = {
            status: 'query_failed'
          };
        }
        if (found.status !== 'ok' || found.pids.length > 1) {
          verdict = 'query_failed';
        } else if (!found.pids.length) {
          verdict = 'never_started';
        } else {
          const markedProcess = found.pids[0];
          writeTransaction(() => transitionIncarnation(incarnation, [incarnation.state], {
            pid: markedProcess.pid,
            pid_started_at: markedProcess.startedAt
          }));
          incarnation = getIncarnation(incarnation.id);
          verdict = checkIdentity(incarnation);
        }
      } else {
        verdict = checkIdentity(incarnation);
      }
      writeTransaction(() => {
        transitionIncarnation(incarnation, [incarnation.state], {
          state: getRecoveredIncarnationState(verdict),
          end_reason: 'host_lost'
        });
        finishIncarnationDeliveries(incarnation);
      });
    }
    for (const controlRequest of getRows("SELECT * FROM control_requests WHERE state='accepted'")) {
      if (controlRequest.kind === 'delete') {
        continue;
      }
      const incarnation = controlRequest.incarnation_id && getIncarnation(controlRequest.incarnation_id);
      if (['start', 'resume'].includes(controlRequest.kind)) {
        writeTransaction(() => transitionControl(controlRequest, getRecoveredStartResult(incarnation)));
      } else if (!incarnation || ['exited', 'never_started'].includes(incarnation.state)) {
        finishControlRequest(controlRequest.request_key);
      } else {
        writeTransaction(() => transitionControl(controlRequest, {
          state: 'blocked',
          reason: 'control_lost'
        }));
      }
    }
    for (const session of getRows("SELECT * FROM owned_sessions WHERE state='deleting'")) {
      deleteSessionData(session.id);
    }
    writeTransaction(() => {
      execute('DELETE FROM request_tombstones WHERE expires_at<?', now());
      execute("DELETE FROM control_requests WHERE state!='accepted' AND created_at<?", now() - 30 * DAY);
    });
  }

  // §4.1: a single read view prevents a state/sequence gap during subscription.
  function snapshot(sessionId) {
    return store.read(() => {
      const session = getSession(sessionId);
      if (session && ['deleting', 'deleted'].includes(session.state)) {
        const result = {
          state: {
            session: snapshotPreview(session),
            current_incarnation_id: getLatestIncarnation(sessionId)?.id || null
          },
          seq_high: getRow('SELECT COALESCE(MAX(seq),0) n FROM events').n
        };
        if (Buffer.byteLength(JSON.stringify(result)) > snapshotMaxBytes) {
          throw Object.assign(new Error('snapshot_too_large'), { code: 'snapshot_too_large' });
        }
        return result;
      }
      function rows(sql, parameters, transform = value => value) {
        return Array.from(database.prepare(sql + ' ORDER BY rowid ASC').iterate(...parameters), row => snapshotPreview(transform(row)));
      }
      const state = {
        session: session ? snapshotPreview(session) : null,
        ...(session?.state === 'handed_off' ? {
          handoff_command: JSON.parse(getRow("SELECT json FROM events WHERE session_id=? AND type='handoff_ready' ORDER BY seq DESC LIMIT 1",
            sessionId)?.json || '{}').command
        } : {}),
        current_incarnation_id: getLatestIncarnation(sessionId)?.id || null,
        ...((session?.state === 'active' && getRow("SELECT request_key FROM control_requests WHERE session_id=? AND kind='handoff' AND state='blocked'",
          sessionId)) ? { handoff_subprocesses: (() => {
          try { return identityProbe.listMarkedDescendants(getLatestIncarnation(sessionId)?.id); }
          catch { return { status: 'query_failed', pids: [] }; }
        })() } : {}),
        incarnations: rows('SELECT * FROM incarnations WHERE session_id=?', [sessionId], incarnation => {
          const event = getRow("SELECT json FROM events WHERE incarnation_id=? AND type='rate_limit' ORDER BY seq DESC LIMIT 1", incarnation.id);
          // Only a live, locally verified gate provides version and control evidence.
          const verified = incarnation.host_boot_id === hostBootId && hasPassedGate(incarnation);
          const caps = incarnation.capabilities === null ? undefined : JSON.parse(incarnation.capabilities);
          const capabilityVerdict = verified ? evaluateCapabilities({
            sdkVersion: pin.sdkVersion, cliVersion: pin.cliVersion, permissionMode: 'default', systemInitCapabilities: caps
          }) : null;
          return { ...incarnation, rate_limit_info: event ? JSON.parse(event.json) : null,
            cli_version: verified ? pin.cliVersion : null, control_available: !!verified && incarnation.state === 'alive', capabilityVerdict };
        }),
        deliveries: rows('SELECT * FROM deliveries WHERE session_id=?', [sessionId]),
        tool_requests: rows('SELECT * FROM tool_requests WHERE incarnation_id IN (SELECT id FROM incarnations WHERE session_id=?)', [sessionId], card => ({
          ...card, created_at: getRow("SELECT created_at FROM events WHERE incarnation_id=? AND type='sdk' AND json_extract(json,'$.type')='tool_request' AND json_extract(json,'$.tool_use_id')=? ORDER BY seq LIMIT 1", card.incarnation_id, card.tool_use_id)?.created_at || null
        })),
        controls: rows('SELECT * FROM control_requests WHERE session_id=?', [sessionId])
      };
      store.readCheckpoint();
      const result = { state, seq_high: getRow('SELECT COALESCE(MAX(seq),0) n FROM events').n };
      const bytes = () => Buffer.byteLength(JSON.stringify(result));
      // Preserve every row; only body/input previews shrink to meet the byte budget.
      for (let limit = 2048; bytes() > snapshotMaxBytes; limit = Math.floor(limit / 2)) {
        for (const name of ['incarnations', 'deliveries', 'tool_requests', 'controls']) {
          state[name] = state[name].map(row => snapshotPreview(row, limit));
        }
        if (limit === 0) break;
      }
      if (bytes() > snapshotMaxBytes) throw Object.assign(new Error('snapshot_too_large'), { code: 'snapshot_too_large' });
      return result;
    });
  }

  function listSessions() {
    return store.read(() => {
      const sessions = getRows("SELECT id,title,cwd,state,created_at FROM owned_sessions WHERE state!='deleted'").map(session => {
        const incarnation = getLatestIncarnation(session.id);
        return {
          ...session,
          incarnation: incarnation ? {
            id: incarnation.id, state: incarnation.state, has_pid: incarnation.pid !== null, end_reason: incarnation.end_reason
          } : null,
          attribution_uncertain: incarnation?.attribution_uncertain || 0,
          pending_approvals: incarnation ? getRow("SELECT COUNT(*) n FROM tool_requests WHERE incarnation_id=? AND state='pending'",
            incarnation.id).n : 0,
          last_activity_seq: getRow('SELECT COALESCE(MAX(seq),0) n FROM events WHERE session_id=?', session.id).n
        };
      });
      store.readCheckpoint();
      return { sessions, seq_high: getRow('SELECT COALESCE(MAX(seq),0) n FROM events').n };
    });
  }

  async function settingsPreview(cwd) {
    let timer;
    const failed = { ok: false, reason: 'settings_check_failed' };
    try {
      const started = Date.now();
      const resolved = await Promise.race([
        Promise.resolve().then(() => adapter.checkSettings(cwd)),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('settings_check_failed')), pin.resolveSettingsDeadlineMs); })
      ]);
      if (Date.now() - started >= pin.resolveSettingsDeadlineMs) return failed;
      const verdict = authGate.evaluateResolvedSettings(resolved);
      if (verdict.reason === 'settings_check_failed') return failed;
      const paths = value => {
        if (Array.isArray(value)) return [...new Set(value.flatMap(paths))];
        if (!value || typeof value !== 'object') return [];
        return [...new Set([
          ...(typeof value.path === 'string' && !/[\0\r\n]/.test(value.path) ? [value.path] : []),
          ...Object.entries(value).filter(([key]) => key !== 'path').flatMap(([, item]) => paths(item))
        ])];
      };
      const provenance = resolved.provenance;
      return {
        ...verdict,
        hooks: Object.keys(resolved.effective.hooks || {}).map(event => ({ event, paths: paths(provenance.hooks) })),
        mcp_servers: Object.keys(resolved.effective.mcpServers || {}).map(name => ({ name, paths: paths(provenance.mcpServers) })),
        source_paths: [...new Set(resolved.sources.flatMap(source => paths({ path: source?.path })))],
        warnings: Object.hasOwn(resolved.effective.hooks || {}, 'PermissionRequest') ? ['permission_request_hook'] : []
      };
    } catch { return failed; }
    finally { clearTimeout(timer); }
  }

  function eventsSince(seq, { maxBytes = 4 * 1024 * 1024 } = {}) {
    const limit = Number.isSafeInteger(maxBytes) && maxBytes > 0 ? Math.min(maxBytes, 12 * 1024 * 1024) : 4 * 1024 * 1024;
    return store.read(() => {
      const high = getRow("SELECT COALESCE((SELECT seq FROM sqlite_sequence WHERE name='events'),0) n").n;
      if (!Number.isSafeInteger(seq) || seq < 0 || seq > high) return { snapshot_required: true };
      const events = [];
      let bytes = 0;
      let last = seq;
      const statement = database.prepare('SELECT * FROM events WHERE seq>? ORDER BY seq');
      for (const row of statement.iterate(seq)) {
        if (row.seq !== last + 1) return { snapshot_required: true };
        const rawBytes = Buffer.byteLength(row.json);
        let event = rawBytes > 12 * 1024 * 1024 ?
          { seq: row.seq, session_id: row.session_id, type: row.type, oversized: true, bytes: rawBytes,
            ref: { source: 'event', id_or_seq: row.seq } } : { ...row, json: JSON.parse(row.json) };
        let size = Buffer.byteLength(JSON.stringify(event));
        if (size > 12 * 1024 * 1024) {
          event = { seq: row.seq, session_id: row.session_id, type: row.type, oversized: true, bytes: size,
            ref: { source: 'event', id_or_seq: row.seq } };
          size = Buffer.byteLength(JSON.stringify(event));
        }
        if (events.length && bytes + size > limit) break;
        events.push(event);
        bytes += size;
        last = row.seq;
      }
      if (!events.length && seq < high) return { snapshot_required: true };
      return { events, seq_high: high, more: last < high };
    });
  }
  function transcript(sessionId, beforeSeq, limit = 50) {
    if (beforeSeq !== undefined && (!Number.isSafeInteger(beforeSeq) || beforeSeq < 0) ||
        !Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error('invalid_request');
    return store.read(() => {
      const session = getSession(sessionId);
      if (!session || ['deleting', 'deleted'].includes(session.state)) return { events: [], next_before_seq: null };
      const rows = getRows("SELECT seq,session_id,incarnation_id,type,created_at,substr(CAST(json AS BLOB),1,4100) preview," +
    "length(CAST(json AS BLOB)) bytes FROM events WHERE session_id=? AND type='sdk_message' AND seq<? ORDER BY seq DESC LIMIT ?",
      sessionId, beforeSeq ?? Number.MAX_SAFE_INTEGER, limit + 1);
      const more = rows.length > limit;
      const events = rows.slice(0, limit).map(({ preview, ...row }) => {
        const text = utf8Prefix(preview, 4096);
        return { ...row, preview: text, truncated: Buffer.byteLength(text) < row.bytes,
          ref: { source: 'event', id_or_seq: row.seq } };
      });
      return { events, next_before_seq: more ? events.at(-1).seq : null };
    });
  }
  function chunk(sessionId, source, ref, offset = 0) {
    const fail = code => { throw Object.assign(new Error(code), { code }); };
    if (!Number.isSafeInteger(offset) || offset < 0) fail('invalid_offset');
    const sources = {
      event: { table: 'events', column: 'json', where: 'session_id=? AND seq=?' },
      delivery_body: { table: 'deliveries', column: 'body', where: 'session_id=? AND id=?' },
      tool_input: { table: 'tool_requests', column: 'input',
        where: 'incarnation_id IN (SELECT id FROM incarnations WHERE session_id=?) AND id=?' }
    };
    if (!Object.hasOwn(sources, source) || !['string', 'number'].includes(typeof ref) || String(ref).length > 256) fail('invalid_chunk');
    return store.read(() => {
      const session = getSession(sessionId);
      const absent = { found: false, total_bytes: 0, offset, data: '', done: true };
      if (!session || ['deleting', 'deleted'].includes(session.state)) return absent;
      const { table, column, where } = sources[source];
      const row = getRow(`SELECT length(CAST(${column} AS BLOB)) total_bytes, ` +
        `substr(CAST(${column} AS BLOB),?,?) data FROM ${table} WHERE ${where}`, offset + 1, 1024 * 1024 + 4, sessionId, ref);
      if (!row) return absent;
      const total = row.total_bytes || 0;
      if (offset > total) fail('invalid_offset');
      const data = row.data || Buffer.alloc(0);
      if (offset && data.length && (data[0] & 0xc0) === 0x80) fail('invalid_offset');
      const text = utf8Prefix(data, 1024 * 1024);
      return { found: true, total_bytes: total, offset, data: text, done: offset + Buffer.byteLength(text) === total };
    });
  }
  adapter.events.on('event', onEvent);
  return {
    submit,
    abandon,
    async flush() {
      while (pending.size) await Promise.all([...pending]);
      if (asyncErrors.length) throw asyncErrors.shift();
    },
    recover,
    snapshot,
    listSessions,
    settingsPreview,
    eventsSince,
    chunk,
    transcript,
    submitWithReceipt(request) {
      const result = this.submit(request);
      return store.read(() => {
        const persisted = getRow('SELECT * FROM request_aliases WHERE request_key=?', request.request_key) ||
          getRow('SELECT * FROM deliveries WHERE request_key=?', request.request_key) || getControl(request.request_key) ||
          getRow('SELECT * FROM request_tombstones WHERE request_key=?', request.request_key);
        const durable = Boolean(persisted && (persisted.state === 'abandoned' || persisted.fingerprint === requestFingerprint(request)));
        return { durable, result, ...(!durable ? { code: result.reason || 'not_recorded' } : {}) };
      });
    },
    submitUnavailable(request) {
      const result = submit(request);
      if (['start', 'resume'].includes(request.kind) && result.state === 'failed' && ['spawn_failed', 'settings_check_failed'].includes(result.reason)) {
        writeTransaction(() => transitionRow('control_requests', request.request_key, ['failed'],
          { reason: 'adapter_unavailable' }, result.session_id, result.incarnation_id));
        return getControl(request.request_key);
      }
      return result;
    },
    lookup(requestKey) {
      return store.read(() => {
        const alias = getRow('SELECT * FROM request_aliases WHERE request_key=?', requestKey);
        const result = (alias && getDelivery(alias.target_delivery_id)) ||
          getRow('SELECT * FROM deliveries WHERE request_key=?', requestKey) || getControl(requestKey) ||
          getRow('SELECT * FROM request_tombstones WHERE request_key=?', requestKey) || { found: false };
        return result.state === 'abandoned' ? abandonedResult(requestKey) : result;
      });
    },
    activity() {
      return {
        activeSessions: getRow("SELECT COUNT(*) n FROM owned_sessions WHERE state='active'").n,
        pendingCommands: queues.size
      };
    },
    onEvent,
    tick,
    idle: sessionId => isIdle(getLatestIncarnation(sessionId)),
    close() {
      disposed = true;
      accounts.clear();
      settingsTimers.clear();
      adapter.events.off('event', onEvent);
      store.close();
    }
  };
}
module.exports = {
  createHostCore,
  INTERRUPT_RECEIPT_TIMEOUT_MS
};
