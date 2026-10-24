'use strict';
const { randomUUID, createHash } = require('node:crypto');
const { openStore } = require('./store');
const { SimulatedCrash } = require('./faults');

const CONTROLS = new Set(['start', 'resume', 'stop', 'close', 'handoff', 'delete']);
const KINDS = new Set([...CONTROLS, 'prompt', 'tool_decision', 'question_answer', 'interrupt']);
const DAY = 86400000;
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(k => [k, canonical(value[k])]));
  return value;
}
const hash = value => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');

function createHostCore({ dbPath, adapter, identityProbe, clock = Date.now, hostBootId = randomUUID(), faults } = {}) {
  const now = typeof clock === 'function' ? clock : () => clock.now();
  const store = openStore(dbPath, { now, faults }), db = store.db;
  const queues = new Map(), signals = new Map();
  let crashed = false;
  const one = (sql, ...args) => db.prepare(sql).get(...args);
  const all = (sql, ...args) => db.prepare(sql).all(...args);
  const run = (sql, ...args) => db.prepare(sql).run(...args);
  const hit = point => { try { faults?.hit?.(point); } catch (e) { if (e instanceof SimulatedCrash) crashed = true; throw e; } };
  const write = fn => store.write(fn);
  const event = (s, i, type, data) => store.event(s, i, type, data);
  const incarnation = id => one('SELECT * FROM incarnations WHERE id=?', id);
  const session = id => one('SELECT * FROM owned_sessions WHERE id=?', id);
  const latest = id => one('SELECT * FROM incarnations WHERE session_id=? ORDER BY rowid DESC LIMIT 1', id);
  const delivery = id => one('SELECT * FROM deliveries WHERE id=?', id);
  const control = key => one('SELECT * FROM control_requests WHERE request_key=?', key);

  // A transition and its replay record always share the caller's write transaction.
  function change(table, key, from, values, s, i) {
    const column = table === 'control_requests' ? 'request_key' : 'id';
    const keys = Object.keys(values);
    const result = run(`UPDATE ${table} SET ${keys.map(k => `${k}=?`).join(',')} WHERE ${column}=? AND state IN (${from.map(() => '?').join(',')})`, ...keys.map(k => values[k]), key, ...from);
    if (result.changes) {
      const seq = event(s, i, 'transition', { table, id: key, ...values });
      if (table === 'deliveries' || table === 'control_requests') run(`UPDATE ${table} SET seq=?,updated_at=? WHERE ${column}=?`, seq, now(), key);
    }
    return result.changes;
  }
  const dc = (d, from, values) => change('deliveries', d.id, from, values, d.session_id, d.incarnation_id);
  const ic = (i, from, values) => change('incarnations', i.id, from, values, i.session_id, i.id);
  const cc = (c, values) => change('control_requests', c.request_key, ['accepted'], values, c.session_id, c.incarnation_id);
  function sc(s, values) { return change('owned_sessions', s.id, [s.state], values, s.id, null); }
  function tc(t, from, values, i) { return change('tool_requests', t.id, from, values, i.session_id, i.id); }
  function enqueue(s, fn) {
    if (crashed) throw new SimulatedCrash('core_crashed');
    if (queues.has(s)) { queues.get(s).push(fn); return; }
    const q = [fn]; queues.set(s, q);
    try { while (q.length) q.shift()(); }
    finally { queues.delete(s); }
  }
  function idle(i) {
    return i?.state === 'alive' && i.host_boot_id === hostBootId && !i.attribution_uncertain && !i.interrupt_unknown &&
      !one("SELECT id FROM deliveries WHERE incarnation_id=? AND kind='prompt' AND state IN ('sending','written','provider_observed') AND outcome IS NULL LIMIT 1", i.id);
  }
  function safeCheck(method, ...args) {
    try { const v = adapter[method]?.(...args); return v === true; } catch { return false; }
  }
  function descendantsClear(i) {
    if (!i) return true;
    try { const r = identityProbe.listMarkedDescendants(i.id); return r.status === 'ok' && r.pids.length === 0; } catch { return false; }
  }
  function identityCheck(i) {
    try { return identityProbe.check(i.pid, i.pid_started_at); } catch { return 'query_failed'; }
  }
  function uncertain(i) { ic(i, ['alive', 'orphaned'], { attribution_uncertain: 1 }); }
  function taint(i) {
    for (const d of all("SELECT * FROM deliveries WHERE incarnation_id=? AND kind IN ('tool_decision','question_answer') AND state IN ('sending','written')", i.id)) {
      dc(d, ['sending', 'written'], { tainted: 1 });
    }
  }
  function endDeliveries(i) {
    for (const d of all('SELECT * FROM deliveries WHERE incarnation_id=?', i.id)) {
      if (['sending', 'written'].includes(d.state)) dc(d, ['sending', 'written'], { state: 'unknown', reason: 'host_lost' });
      if (d.state === 'queued') dc(d, ['queued'], { state: 'expired', reason: 'incarnation_ended' });
      if (d.kind === 'prompt' && d.outcome === null && ['sending', 'written', 'provider_observed'].includes(d.state)) {
        const r = d.result_json && JSON.parse(d.result_json);
        dc(d, ['sending', 'written', 'provider_observed', 'unknown'], { outcome: r ? r.subtype === 'error_during_execution' ? 'interrupted' : r.is_error ? 'errored' : 'completed' : 'outcome_unknown' });
      }
    }
    for (const t of all("SELECT * FROM tool_requests WHERE incarnation_id=? AND state='pending'", i.id)) tc(t, ['pending'], { state: 'expired' }, i);
  }
  function drain(sid) {
    const i = latest(sid);
    if (!idle(i) || i.close_after_turn) return;
    const d = one("SELECT * FROM deliveries WHERE incarnation_id=? AND kind='prompt' AND state='queued' ORDER BY rowid LIMIT 1", i.id);
    if (d) dispatch(d.id);
  }
  function dispatch(id) {
    let d = delivery(id), i = incarnation(d.incarnation_id);
    if (d.state !== 'queued') return;
    if (d.kind === 'prompt' && i?.state === 'alive' && !idle(i) && !i.attribution_uncertain && !i.interrupt_unknown && !i.close_after_turn) return;
    let decision;
    write(() => {
      const t = d.target_tool_use_id && one('SELECT * FROM tool_requests WHERE incarnation_id=? AND tool_use_id=?', i?.id, d.target_tool_use_id);
      let reason;
      if (!i || i.state !== 'alive' || i.host_boot_id !== hostBootId || session(d.session_id).state !== 'active') reason = 'not_controllable';
      else if (d.kind === 'prompt' && (!idle(i) || i.close_after_turn)) reason = 'not_idle';
      else if (d.kind === 'prompt' && !safeCheck('authCheck', i.id)) reason = 'auth_failed';
      else if (['tool_decision', 'question_answer'].includes(d.kind) && t?.state !== 'pending') reason = 'tool_not_pending';
      if (reason) { dc(d, ['queued'], { state: 'rejected', reason }); return; }
      if (t) {
        const b = JSON.parse(d.body || '{}') || {};
        decision = d.kind === 'question_answer' ? { behavior: 'answer', answer: b.answer ?? b } :
          b.behavior === 'deny' ? { behavior: 'deny', message: `Denied by Palantir user. request=${d.id}` } : { behavior: 'allow' };
        tc(t, ['pending'], { state: 'decided', decision: JSON.stringify(decision), answer_delivery_id: d.id }, i);
      }
      if (d.kind === 'prompt') { ic(i, ['alive'], { turn_gen: i.turn_gen + 1 }); d.turn_gen = i.turn_gen + 1; }
      else d.turn_gen = i.turn_gen;
      dc(d, ['queued'], { state: 'sending', turn_gen: d.turn_gen });
      if (d.kind === 'interrupt') {
        taint(i);
        for (const t of all("SELECT * FROM tool_requests WHERE incarnation_id=? AND state='pending'", i.id)) tc(t, ['pending'], { state: 'cancelled' }, i);
      }
    });
    d = delivery(id);
    if (d.state !== 'sending') return;
    if (decision) hit('after_decided_commit');
    hit('after_sending_commit');
    // No await may separate the durable intent, live SDK facts, and the effect.
    const facts = adapter.facts(i.id, d.target_tool_use_id);
    const signal = signals.get(`${i.id}:${d.target_tool_use_id}`);
    if (incarnation(i.id).state !== 'alive' || facts.exited || facts.aborted || signal?.aborted) {
      write(() => dc(d, ['sending'], { state: 'cancelled', reason: 'effect_invalidated' })); return;
    }
    try {
      if (d.kind === 'prompt') adapter.send(i.id, d.message_uuid, JSON.parse(d.body));
      else if (d.kind === 'interrupt') adapter.interrupt(i.id);
      else adapter.decide(i.id, d.target_tool_use_id, decision);
    } catch (e) {
      if (e instanceof SimulatedCrash) throw e;
      write(() => { dc(d, ['sending', 'written'], { state: 'unknown', reason: 'effect_failed' }); uncertain(i); });
      return;
    }
    hit('after_effect_before_written');
    write(() => {
      dc(d, ['sending'], { state: 'written' });
      if (d.kind === 'interrupt' && delivery(id).state === 'written') {
        dc(d, ['written'], { state: 'unknown', reason: 'interrupt_unconfirmed' });
        ic(i, ['alive'], { interrupt_unknown: 1 });
      }
    });
  }
  function finishControl(key) {
    const c = control(key), i = c.incarnation_id && incarnation(c.incarnation_id);
    if (c.state !== 'accepted') return;
    if (i && !['exited', 'never_started'].includes(i.state)) return;
    write(() => cc(c, { stage: 'exit_confirmed' }));
    if (!descendantsClear(i)) { write(() => cc(c, { state: 'blocked', reason: 'subprocess_remaining' })); return; }
    write(() => {
      cc(c, { stage: 'subprocess_checked' });
      if (i) ic(i, ['exited', 'never_started'], { end_reason: c.kind === 'stop' ? 'user_restart' : 'user_stop' });
      if (c.kind !== 'stop') sc(session(c.session_id), { state: c.kind === 'handoff' ? 'handed_off' : 'closed' });
      cc(c, { state: 'done', stage: 'done' });
    });
  }
  function erase(sid) {
    write(() => {
      for (const d of all('SELECT * FROM deliveries WHERE session_id=?', sid)) run('INSERT OR REPLACE INTO request_tombstones VALUES(?,?,?,?,?)', d.request_key, d.fingerprint, d.state, 1, now() + 30 * DAY);
      run('DELETE FROM events WHERE session_id=?', sid);
      run('DELETE FROM tool_requests WHERE incarnation_id IN (SELECT id FROM incarnations WHERE session_id=?)', sid);
      run('DELETE FROM deliveries WHERE session_id=?', sid);
      for (const i of all('SELECT * FROM incarnations WHERE session_id=?', sid)) {
        ic(i, [i.state], { host_boot_id: '', pid: null, pid_started_at: null, sdk_version: null,
          cli_path: null, cli_sha256: null, account_snapshot: null, capabilities: null,
          started_at: null, ended_at: null, end_reason: null, turn_gen: 0,
          attribution_uncertain: 0, interrupt_unknown: 0, close_after_turn: 0 });
      }
      sc(session(sid), { cwd: null, title: null, claude_session_id: null });
    });
    try {
      db.pragma('wal_checkpoint(TRUNCATE)'); db.exec('VACUUM');
      // VACUUM itself writes WAL frames; flush those before declaring deletion.
      db.pragma('wal_checkpoint(TRUNCATE)');
    } catch (e) {
      // Route maintenance failures through the same fail-closed storage latch.
      write(() => { throw e; });
    }
    write(() => {
      sc(session(sid), { state: 'deleted' });
      for (const c of all("SELECT * FROM control_requests WHERE session_id=? AND kind='delete' AND state='accepted'", sid)) cc(c, { stage: 'done', state: 'done' });
    });
  }
  function executeControl(key) {
    let c = control(key), i = c.incarnation_id && incarnation(c.incarnation_id);
    if (c.state !== 'accepted') return;
    if (c.kind === 'delete') { hit('after_deleting_commit'); erase(c.session_id); return; }
    if (c.kind === 'start' || c.kind === 'resume') {
      write(() => cc(c, { stage: 'spawn_sent' })); hit('after_spawn_sent_before_spawn');
      let p;
      try { p = adapter.start({ incarnation_id: i.id, session_id: c.session_id, cwd: session(c.session_id).cwd }); }
      catch (e) {
        if (e instanceof SimulatedCrash) throw e;
        write(() => { ic(i, ['spawning'], { state: 'never_started' }); cc(c, { state: 'failed', reason: 'spawn_failed' }); }); return;
      }
      hit('after_spawn_before_identity');
      write(() => {
        ic(i, ['spawning'], { state: 'alive', pid: p.pid, pid_started_at: p.startedAt, started_at: now() });
        sc(session(c.session_id), { claude_session_id: p.claude_session_id || c.session_id });
      });
      if (!safeCheck('authCheck', i.id)) {
        adapter.close(i.id);
        if (incarnation(i.id).state !== 'exited') {
          if (identityCheck(incarnation(i.id)) === 'match') adapter.signal?.(i.id, 'SIGTERM');
          if (incarnation(i.id).state !== 'exited') write(() => ic(incarnation(i.id), ['alive'], { state: 'liveness_unknown' }));
        }
        write(() => cc(c, { state: 'failed', reason: 'auth_failed' }));
      } else write(() => cc(c, { stage: 'done', state: 'done' }));
      return;
    }
    if (!i || ['exited', 'never_started'].includes(i.state)) { finishControl(key); return; }
    if (i.state === 'orphaned') {
      const verdict = identityCheck(i);
      if (verdict !== 'match') { write(() => cc(c, { state: 'failed', reason: verdict === 'query_failed' ? 'liveness_unknown' : 'identity_mismatch' })); return; }
      write(() => cc(c, { stage: 'signal_sent' })); hit('after_close_sent');
      adapter.signal(i.id, 'SIGTERM');
    } else {
      write(() => cc(c, { stage: 'close_sent' })); hit('after_close_sent');
      if (c.kind === 'handoff') {
        write(() => {
          taint(i);
          for (const t of all("SELECT * FROM tool_requests WHERE incarnation_id=? AND state='pending'", i.id)) tc(t, ['pending'], { state: 'cancelled' }, i);
        });
        adapter.interrupt(i.id);
      }
      if (incarnation(i.id).state !== 'exited') adapter.close(i.id);
    }
    finishControl(key);
  }
  function fingerprint(req) { return hash([req.kind, req.session_id || null, req.incarnation_id || null, req.target_tool_use_id || null, hash(req.body ?? null), hash(req.cwd ?? null)]); }
  function submit(req) {
    if (crashed) throw new SimulatedCrash('core_crashed');
    if (store.failed) throw new Error('storage_unavailable');
    const fp = fingerprint(req);
    const existing = one('SELECT * FROM deliveries WHERE request_key=?', req.request_key) || control(req.request_key) || one('SELECT * FROM request_tombstones WHERE request_key=?', req.request_key);
    if (existing) {
      if (existing.fingerprint !== fp) return { state: 'rejected', reason: 'fingerprint_conflict', status: 409 };
      return existing;
    }
    const m = /^rk_(\d{1,16})_([a-fA-F0-9]{16,})$/.exec(req.request_key || '');
    if (!m || !KINDS.has(req.kind)) return { state: 'rejected', reason: 'invalid_request' };
    if (+m[1] < now() - DAY) return { state: 'expired', reason: 'key_expired' };
    if (+m[1] > now() + 300000) return { state: 'rejected', reason: 'key_future' };
    const isControl = CONTROLS.has(req.kind);
    let result;
    const sid = req.kind === 'start' ? randomUUID() : req.session_id;
    enqueue(sid, () => {
      let s = sid && session(sid), i = s && latest(sid), reason;
      if (req.kind !== 'start' && (!s || ['deleting', 'deleted'].includes(s.state))) reason = 'session_unavailable';
      if (isControl) {
        if (!reason && one("SELECT request_key FROM control_requests WHERE session_id=? AND state='accepted'", sid)) reason = 'busy';
        if (!reason && req.kind === 'start' && !safeCheck('settingsCheck', req.cwd)) reason = 'settings_failed';
        if (!reason && req.kind === 'resume') {
          if (s.state !== 'active') reason = 'session_inactive';
          else if (!i || !['exited', 'never_started'].includes(i.state)) reason = i?.state === 'liveness_unknown' ? 'liveness_unknown' : 'busy';
          else if (!descendantsClear(i)) reason = 'subprocess_remaining';
          else if (!safeCheck('settingsCheck', s.cwd)) reason = 'settings_failed';
        }
        if (!reason && ['stop', 'close', 'handoff'].includes(req.kind)) {
          if (s.state !== 'active') reason = 'session_inactive';
          else if (i && !['alive', 'orphaned', 'exited', 'never_started'].includes(i.state)) reason = i.state === 'liveness_unknown' ? 'liveness_unknown' : 'busy';
          else if (req.kind === 'handoff' && (!i || !s.claude_session_id)) reason = 'no_session_id';
        }
        if (!reason && req.kind === 'delete' && !['closed', 'handed_off'].includes(s.state)) reason = 'session_active';
        const iid = ['start', 'resume'].includes(req.kind) && !reason ? randomUUID() : i?.id || null;
        write(() => {
          if (!reason && req.kind === 'start') {
            run('INSERT INTO owned_sessions VALUES(?,?,?,?,?,?)', sid, req.cwd || null, null, null, 'active', now()); event(sid, null, 'session_reserved', { id: sid });
          }
          if (!reason && ['start', 'resume'].includes(req.kind)) {
            run('INSERT INTO incarnations(id,session_id,host_boot_id,state) VALUES(?,?,?,?)', iid, sid, hostBootId, 'spawning'); event(sid, iid, 'incarnation_reserved', { id: iid });
          }
          run('INSERT INTO control_requests(request_key,fingerprint,kind,session_id,incarnation_id,stage,state,reason,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)', req.request_key, fp, req.kind, sid || null, iid, 'requested', reason ? 'rejected' : 'accepted', reason || null, now(), now());
          event(sid, iid, 'control_accepted', { request_key: req.request_key, state: reason ? 'rejected' : 'accepted' });
          if (!reason && req.kind === 'delete') sc(s, { state: 'deleting' });
        });
        if (!reason) { hit('after_control_accept_before_reply'); executeControl(req.request_key); }
        result = control(req.request_key);
      } else {
        if (!reason && (s.state !== 'active' || !i || req.incarnation_id !== i.id)) reason = 'incarnation_mismatch';
        if (!reason && req.kind === 'interrupt') {
          const pending = one("SELECT * FROM deliveries WHERE incarnation_id=? AND kind='interrupt' AND state IN ('queued','sending','written','provider_observed','unknown') ORDER BY rowid DESC LIMIT 1", i.id);
          if (pending) { result = pending; return; }
        }
        const id = randomUUID();
        write(() => {
          run('INSERT INTO deliveries(id,session_id,incarnation_id,kind,body,target_tool_use_id,request_key,fingerprint,message_uuid,state,reason,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)', id, sid || '', req.incarnation_id || null, req.kind, JSON.stringify(req.body ?? null), req.target_tool_use_id || null, req.request_key, fp, randomUUID(), reason ? 'rejected' : 'queued', reason || null, now(), now());
          event(sid, req.incarnation_id, 'delivery_accepted', { id, state: reason ? 'rejected' : 'queued' });
        });
        if (!reason) dispatch(id);
        result = delivery(id);
      }
    });
    hit('before_accepted_reply');
    // Synchronous callbacks may have advanced the row while the queue drained.
    return (result?.id ? delivery(result.id) : result?.request_key ? control(result.request_key) || result : result) || { state: 'accepted', request_key: req.request_key };
  }

  function onEvent(e) {
    if (crashed || store.failed) return;
    const i = incarnation(e.incarnation_id);
    if (!i || ['deleting', 'deleted'].includes(session(i.session_id)?.state)) return;
    // Exit and abort must invalidate effects even while a command owns the queue.
    if (e.type === 'child_exit' || e.type === 'signal_abort') immediate(e, i);
    enqueue(i.session_id, () => {
      write(() => {
        const { signal, ...raw } = e;
        event(i.session_id, i.id, 'sdk', raw);
        if (e.type === 'tool_request') {
          if (i.state !== 'alive') return;
          run('INSERT OR IGNORE INTO tool_requests VALUES(?,?,?,?,?,?,?,?)', randomUUID(), i.id, e.tool_use_id, e.name, JSON.stringify(e.input), e.signal?.aborted ? 'cancelled' : 'pending', null, null);
          event(i.session_id, i.id, 'tool_pending', { tool_use_id: e.tool_use_id });
          if (e.signal) {
            signals.set(`${i.id}:${e.tool_use_id}`, e.signal);
            e.signal.addEventListener('abort', () => onEvent({ incarnation_id: i.id, type: 'signal_abort', tool_use_id: e.tool_use_id }), { once: true });
          }
        } else if (e.type === 'lifecycle') {
          const d = one("SELECT * FROM deliveries WHERE incarnation_id=? AND kind='prompt' AND message_uuid=?", i.id, e.command_uuid);
          if (!d || incarnation(i.id).attribution_uncertain) return;
          if (['queued', 'started'].includes(e.state)) dc(d, ['sending', 'written', 'unknown'], { state: 'provider_observed' });
          if (e.state === 'completed') {
            const r = d.result_json && JSON.parse(d.result_json);
            dc(d, ['sending', 'written', 'provider_observed', 'unknown'], { state: 'completed', outcome: r ? r.is_error ? 'errored' : 'completed' : 'outcome_unknown' });
          }
          if (e.state === 'cancelled') dc(d, ['sending', 'written', 'provider_observed', 'unknown'], { state: 'provider_observed', outcome: 'interrupted' });
        } else if (e.type === 'result') {
          const uuids = e.user_message_uuids || [];
          if (uuids.length !== 1) { if (uuids.length > 1) uncertain(i); return; }
          const d = one("SELECT * FROM deliveries WHERE incarnation_id=? AND kind='prompt' AND message_uuid=?", i.id, uuids[0]);
          if (!d || incarnation(i.id).attribution_uncertain) return;
          dc(d, ['sending', 'written', 'provider_observed', 'unknown', 'completed'], { result_json: JSON.stringify(e) });
          for (const int of all("SELECT * FROM deliveries WHERE incarnation_id=? AND kind='interrupt' AND turn_gen=? AND state IN ('sending','written','provider_observed','unknown')", i.id, d.turn_gen)) {
            dc(int, ['sending', 'written', 'provider_observed', 'unknown'], { state: 'completed' }); ic(i, ['alive'], { interrupt_unknown: 0 });
          }
        } else if (e.type === 'tool_result') {
          const t = one('SELECT * FROM tool_requests WHERE incarnation_id=? AND tool_use_id=?', i.id, e.tool_use_id);
          if (!t?.answer_delivery_id) return;
          const d = delivery(t.answer_delivery_id), decision = JSON.parse(t.decision);
          const observed = decision.behavior === 'deny' ? e.is_error === true && e.content === decision.message :
            decision.behavior === 'answer' ? !e.is_error && JSON.stringify(e.content) === JSON.stringify(decision.answer) : !e.is_error && !d.tainted;
          dc(d, ['sending', 'written', 'unknown'], { state: observed ? 'provider_observed' : 'unknown', reason: observed ? null : e.is_error ? 'tool_finished_error' : 'tool_finished' });
        } else if (e.type === 'interrupt_receipt') {
          const d = one("SELECT * FROM deliveries WHERE incarnation_id=? AND kind='interrupt' ORDER BY rowid DESC LIMIT 1", i.id);
          if (!d) return;
          dc(d, ['sending', 'written', 'unknown'], { state: 'provider_observed' });
          ic(i, ['alive'], { interrupt_unknown: 0 });
          if (e.still_queued?.length) {
            uncertain(i);
            for (const uuid of e.still_queued) {
              const p = one('SELECT * FROM deliveries WHERE incarnation_id=? AND message_uuid=?', i.id, uuid);
              if (p) dc(p, ['sending', 'written', 'unknown'], { state: 'provider_observed' });
            }
          }
        } else if (e.type === 'system_init') {
          ic(i, ['alive'], { capabilities: JSON.stringify(e.capabilities || []), close_after_turn:
            ['msg_lifecycle_v1', 'interrupt_receipt_v1'].every(c => e.capabilities?.includes(c)) && (!e.apiKeySource || e.apiKeySource === 'none') ? 0 : 1 });
        } else if (e.type === 'child_exit') endDeliveries(incarnation(i.id));
      });
      if (e.type === 'child_exit') for (const c of all("SELECT * FROM control_requests WHERE incarnation_id=? AND state='accepted' AND kind IN ('stop','close','handoff')", i.id)) finishControl(c.request_key);
      const current = incarnation(i.id);
      if (current?.close_after_turn && idle(current)) {
        adapter.close(i.id);
        write(() => { if (incarnation(i.id).state === 'exited') sc(session(i.session_id), { state: 'closed' }); });
      } else drain(i.session_id);
    });
  }
  function immediate(e, i) {
    write(() => {
      if (e.type === 'child_exit') {
        ic(i, ['spawning', 'alive', 'orphaned', 'liveness_unknown'], { state: 'exited', ended_at: now() }); taint(i);
      } else {
        const t = one('SELECT * FROM tool_requests WHERE incarnation_id=? AND tool_use_id=?', i.id, e.tool_use_id);
        if (!t) return;
        const d = t.answer_delivery_id && delivery(t.answer_delivery_id);
        if (t.state === 'pending' || (t.state === 'decided' && d?.state === 'queued')) {
          tc(t, ['pending', 'decided'], { state: 'cancelled' }, i);
          if (d) dc(d, ['queued'], { state: 'cancelled', reason: 'signal_abort' });
        } else if (d) {
          dc(d, ['sending', 'written'], { tainted: 1 });
          event(i.session_id, i.id, 'decision_tool_aborted', { delivery_id: d.id });
        }
      }
    });
  }
  function recover() {
    if (crashed) throw new SimulatedCrash('core_crashed');
    for (let i of all("SELECT * FROM incarnations WHERE state IN ('spawning','alive','orphaned','liveness_unknown')")) {
      let verdict;
      if (!i.pid) {
        let found; try { found = identityProbe.findMarked(i.id); } catch { found = { status: 'query_failed' }; }
        if (found.status !== 'ok' || found.pids.length > 1) verdict = 'query_failed';
        else if (!found.pids.length) verdict = 'never_started';
        else {
          const p = found.pids[0];
          write(() => ic(i, [i.state], { pid: p.pid, pid_started_at: p.startedAt })); i = incarnation(i.id); verdict = identityCheck(i);
        }
      } else verdict = identityCheck(i);
      write(() => {
        ic(i, [i.state], { state: verdict === 'never_started' ? 'never_started' : verdict === 'match' ? 'orphaned' : verdict === 'mismatch_confirmed' ? 'exited' : 'liveness_unknown', end_reason: 'host_lost' });
        endDeliveries(i);
      });
    }
    for (const c of all("SELECT * FROM control_requests WHERE state='accepted'")) {
      if (c.kind === 'delete') continue;
      const i = c.incarnation_id && incarnation(c.incarnation_id);
      if (['start', 'resume'].includes(c.kind)) write(() => cc(c, { state: 'failed', reason: i?.state === 'never_started' ? 'not_started' : 'control_lost' }));
      else if (!i || ['exited', 'never_started'].includes(i.state)) finishControl(c.request_key);
      else write(() => cc(c, { state: 'blocked', reason: 'control_lost' }));
    }
    for (const s of all("SELECT * FROM owned_sessions WHERE state='deleting'")) erase(s.id);
    write(() => {
      run('DELETE FROM request_tombstones WHERE expires_at<?', now());
      run("DELETE FROM control_requests WHERE state!='accepted' AND created_at<?", now() - 30 * DAY);
    });
  }
  function snapshot(sid) {
    return store.read(() => {
      const s = session(sid);
      if (s && ['deleting', 'deleted'].includes(s.state)) return { state: { session: s }, seq_high: one('SELECT COALESCE(MAX(seq),0) n FROM events').n };
      return { state: { session: s || null, incarnations: all('SELECT * FROM incarnations WHERE session_id=?', sid), deliveries: all('SELECT * FROM deliveries WHERE session_id=?', sid), tool_requests: all('SELECT * FROM tool_requests WHERE incarnation_id IN (SELECT id FROM incarnations WHERE session_id=?)', sid), controls: all('SELECT * FROM control_requests WHERE session_id=?', sid) }, seq_high: one('SELECT COALESCE(MAX(seq),0) n FROM events').n };
    });
  }
  function eventsSince(seq) {
    return store.read(() => {
      const rows = all('SELECT * FROM events WHERE seq>? ORDER BY seq', seq);
      const high = one("SELECT COALESCE((SELECT seq FROM sqlite_sequence WHERE name='events'),0) n").n;
      if (seq < 0 || seq > high || (seq < high && (!rows.length || rows[0].seq !== seq + 1)) || rows.some((r, n) => n && r.seq !== rows[n - 1].seq + 1)) return { snapshot_required: true };
      return { events: rows.map(r => ({ ...r, json: JSON.parse(r.json) })), seq_high: high };
    });
  }
  adapter.events.on('event', onEvent);
  return { submit, recover, snapshot, eventsSince, onEvent, idle: sid => idle(latest(sid)),
    close() { adapter.events.off('event', onEvent); store.close(); } };
}
module.exports = { createHostCore };
