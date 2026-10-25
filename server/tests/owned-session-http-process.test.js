'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { randomBytes } = require('node:crypto');
const { poll } = require('./helpers/session-host-process');
const root = '/api/owned-sessions';
const key = () => `rk_${Date.now()}_${randomBytes(8).toString('hex')}`;
function launch(entry, dir) {
  const child = spawn(process.execPath, [path.join(__dirname, 'helpers', entry), dir], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  child.errors = ''; child.messages = [];
  child.stderr.on('data', chunk => { child.errors += chunk; });
  child.on('message', message => child.messages.push(message));
  return child;
}
async function message(child, type) {
  return poll(() => {
    const found = child.messages.find(item => item.type === type);
    if (found) return found;
    if (child.exitCode !== null || child.signalCode !== null) throw Error(child.errors || 'child_exited');
    return false;
  }, 10000);
}
async function settledPrompt(server, requestKey) {
  return poll(async () => {
    const row = (await server.call('/requests/' + requestKey)).body.result;
    return row && row.outcome !== null && row.outcome !== undefined && row;
  });
}
async function settledControl(server, requestKey) {
  return poll(async () => {
    const row = (await server.call('/requests/' + requestKey)).body.result;
    return row && row.state !== 'accepted' && row;
  });
}
async function setup(t) {
  const dir = fs.mkdtempSync('/private/tmp/owned-http-'); const children = [], controllers = [];
  let host;
  t.after(async () => {
    for (const controller of controllers) controller.abort();
    for (const child of children.filter(item => item !== host)) {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL'); await new Promise(resolve => child.once('exit', resolve));
      }
    }
    if (host?.connected && host.exitCode === null && host.signalCode === null) {
      host.send('cleanup'); await message(host, 'cleaned');
    }
    if (host && host.exitCode === null && host.signalCode === null) {
      host.kill('SIGKILL'); await new Promise(resolve => host.once('exit', resolve));
    }
    fs.rmSync(dir, { force: true, recursive: true });
  });
  host = launch('owned-session-sdk-host.cjs', dir); children.push(host); await message(host, 'ready');
  async function server() {
    const child = launch('owned-session-http-server.cjs', dir); children.push(child);
    const ready = await message(child, 'ready');
    const origin = `http://127.0.0.1:${ready.port}`;
    return { child, origin, async call(route, method = 'GET', body, bearer = false) {
      const response = await fetch(origin + root + route, { method,
        headers: { ...(bearer ? { Authorization: 'Bearer owned-test-token' } : { Cookie: 'palantir_token=owned-test-token' }),
          Origin: origin, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
      return { status: response.status, body: await response.json() };
    } };
  }
  const logs = () => {
    try { return fs.readFileSync(path.join(dir, 'fake-claude.log'), 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse); }
    catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  };
  return { dir, host, server, logs, controllers };
}
for (const signal of ['SIGTERM', 'SIGKILL']) {
  test('HTTP real SDK pending approval survives server ' + signal + ' with one provider tool effect', { timeout: 30000 }, async t => {
    const f = await setup(t); let server = await f.server();
    assert.equal((await server.call('/settings-preview', 'POST', { cwd: f.dir })).status, 200);
    const started = await server.call('/start', 'POST', { cwd: f.dir, confirmed_settings: true, request_key: key() });
    assert.equal(started.status, 200); const id = started.body.result.session_id;
    const snapshot = await poll(async () => { const value = await server.call('/' + id); return value.body.state?.current_incarnation_id &&
      value.body.state.incarnations.some(row => row.state === 'alive' && row.account_snapshot) && value.body; });
    const incarnation_id = snapshot.state.current_incarnation_id;
    const target = { request_key: key(), incarnation_id, body: 'tool' };
    assert.equal((await server.call('/' + id + '/prompt', 'POST', target)).status, 200);
    const pending = await poll(async () => {
      const value = await server.call('/' + id); return value.body.state?.tool_requests.find(row => row.state === 'pending');
    });
    const pid = f.logs().find(row => row.type === 'spawn').pid;
    server.child.kill(signal); await new Promise(resolve => server.child.once('exit', resolve));
    assert.doesNotThrow(() => process.kill(f.host.pid, 0)); assert.doesNotThrow(() => process.kill(pid, 0));
    server = await f.server();
    assert.equal((await server.call('/' + id)).body.state.tool_requests[0].state, 'pending');
    const decision = { request_key: key(), incarnation_id, tool_use_id: pending.tool_use_id, behavior: 'allow' };
    assert.equal((await server.call('/' + id + '/tool-decision', 'POST', decision)).status, 200);
    await server.call('/' + id + '/tool-decision', 'POST', decision);
    await poll(() => f.logs().some(row => row.type === 'tool'));
    assert.equal(f.logs().filter(row => row.type === 'tool').length, 1);
    await settledPrompt(server, target.request_key);
    // Authentication changes alone; the request remains otherwise identical.
    assert.equal((await server.call('/' + id + '/prompt', 'POST', target, true)).status, 403);
    if (signal === 'SIGTERM') {
      const before = await server.call('/' + id); const seq = before.body.seq_high;
      const prompt = { request_key: key(), incarnation_id, body: 'hello' };
      await server.call('/' + id + '/prompt', 'POST', prompt);
      await poll(() => f.logs().filter(row => row.type === 'user').length === 2);
      const controller = new AbortController(); f.controllers.push(controller);
      const completed = await poll(async () => { const value = (await server.call('/' + id)).body;
        return value.state.deliveries.some(row => row.request_key === prompt.request_key && row.state === 'completed' && row.outcome !== null) && value; });
      const high = completed.seq_high;
      const response = await fetch(server.origin + root + '/stream?since=' + seq,
        { headers: { Cookie: 'palantir_token=owned-test-token' }, signal: controller.signal });
      const reader = response.body.getReader(); let text = ''; const seen = [];
      while ((seen.at(-1) || seq) < high) {
        const chunk = await reader.read(); text += Buffer.from(chunk.value).toString();
        const frames = text.split('\n\n'); text = frames.pop();
        for (const frame of frames) {
          const data = frame.split('\n').find(line => line.startsWith('data: '));
          if (data) { const event = JSON.parse(data.slice(6)); if (event.seq > seq) seen.push(event.seq); }
        }
      }
      assert.deepEqual(seen.filter(value => value <= high), Array.from({ length: high - seq }, (_, index) => seq + index + 1));
      assert.equal(new Set(seen).size, seen.length);
      controller.abort();
      await poll(async () => {
        server.child.messages = server.child.messages.filter(item => item.type !== 'stats');
        server.child.send('stats'); return (await message(server.child, 'stats')).subscriptions === 0;
      });
      await poll(async () => (await server.call('/' + id)).body.state.deliveries.some(row => row.request_key === prompt.request_key && row.state === 'completed' && row.outcome !== null));
      // A separate stopped session proves resume is normally executable before the DB fault.
      const extra = await server.call('/start', 'POST', { request_key: key(), cwd: f.dir, confirmed_settings: true });
      const extraId = extra.body.result.session_id;
      assert.equal((await settledControl(server, extra.body.request_key)).state, 'done');
      const stopped = await server.call('/' + extraId + '/stop', 'POST', { request_key: key() });
      assert.equal((await settledControl(server, stopped.body.request_key)).state, 'done');
      const beforeResume = f.logs().filter(row => row.type === 'spawn').length;
      const resumed = await server.call('/' + extraId + '/resume', 'POST', { request_key: key() });
      assert.equal((await settledControl(server, resumed.body.request_key)).state, 'done');
      assert.equal(f.logs().filter(row => row.type === 'spawn').length, beforeResume + 1);
      const stoppedAgain = await server.call('/' + extraId + '/stop', 'POST', { request_key: key() });
      assert.equal((await settledControl(server, stoppedAgain.body.request_key)).state, 'done');
      const ended = (await server.call('/' + extraId)).body.state;
      const endedIncarnation = ended.incarnations.find(row => row.id === ended.current_incarnation_id);
      assert.equal(endedIncarnation.state, 'exited');
      await poll(() => { try { process.kill(endedIncarnation.pid, 0); return false; } catch (error) {
        if (error.code === 'ESRCH') return true; throw error;
      } });
      const effects = f.logs().filter(row => row.type === 'user').length;
      const spawned = f.logs().filter(row => row.type === 'spawn').map(row => row.pid);
      f.host.send('fail-db'); await message(f.host, 'db-failed');
      for (const [route, body] of [['/' + id + '/prompt', { ...prompt, request_key: key() }],
        ['/start', { request_key: key(), cwd: f.dir, confirmed_settings: true }], ['/' + extraId + '/resume', { request_key: key() }]]) {
        const failed = await server.call(route, 'POST', body);
        assert.ok(failed.status === 503 || failed.body.acceptance === 'acceptance_unknown');
      }
      assert.equal(f.logs().filter(row => row.type === 'user').length, effects);
      assert.deepEqual(f.logs().filter(row => row.type === 'spawn').map(row => row.pid), spawned);
      assert.doesNotThrow(() => process.kill(pid, 0));
    }
  });
}

test('HTTP real SDK socket failure preserves pending last-known; identical previously valid mutations all return 503',
  { timeout: 30000 }, async t => {
    const f = await setup(t); const server = await f.server(); const controls = [];
    async function send(route, body, method = 'POST') {
      const result = await server.call(route, method, body);
      assert.equal(result.status, 200); assert.notEqual(result.body.result?.state, 'rejected');
      controls.push({ route, body, method }); return result.body;
    }
    const started = await send('/start', { request_key: key(), cwd: f.dir, confirmed_settings: true });
    await settledControl(server, started.request_key); const id = started.result.session_id;
    let incarnation_id = (await server.call('/' + id)).body.state.current_incarnation_id;
    await send('/settings-preview', { cwd: f.dir });
    for (const [text, action] of [['hello', null], ['tool', 'tool-decision'], ['question', 'question-answer'], ['tool', 'interrupt']]) {
      const prompt = await send('/' + id + '/prompt', { request_key: key(), incarnation_id, body: text });
      if (action) {
        const pending = await poll(async () => (await server.call('/' + id)).body.state.tool_requests.find(row => row.state === 'pending'));
        const body = { request_key: key(), incarnation_id, ...(action !== 'interrupt' ? { tool_use_id: pending.tool_use_id } : {}),
          ...(action === 'tool-decision' ? { behavior: 'allow' } : {}), ...(action === 'question-answer' ? { answer: { [JSON.parse(pending.input).questions[0].question]: 'A' } } : {}) };
        await send('/' + id + '/' + action, body);
      }
      await settledPrompt(server, prompt.request_key);
    }
    const stop = await send('/' + id + '/stop', { request_key: key() }); await settledControl(server, stop.request_key);
    const resume = await send('/' + id + '/resume', { request_key: key() }); await settledControl(server, resume.request_key);
    const close = await send('/' + id + '/close', { request_key: key() }); await settledControl(server, close.request_key);
    const deletion = await send('/' + id, { request_key: key() }, 'DELETE'); await settledControl(server, deletion.request_key);
    const active = await send('/start', { request_key: key(), cwd: f.dir, confirmed_settings: true }); await settledControl(server, active.request_key);
    const activeId = active.result.session_id;
    incarnation_id = (await server.call('/' + activeId)).body.state.current_incarnation_id;
    await send('/' + activeId + '/prompt', { request_key: key(), incarnation_id, body: 'tool' });
    const known = await poll(async () => {
      const value = (await server.call('/' + activeId)).body;
      return value.state.tool_requests.some(row => row.state === 'pending') && value;
    });
    server.child.send('break-socket'); await message(server.child, 'socket-broken');
    const offline = await server.call('/' + activeId);
    assert.equal(offline.body.current_state_known, false); assert.equal(typeof offline.body.as_of, 'number');
    const status = row => ({ id: row.id, incarnation_id: row.incarnation_id, tool_use_id: row.tool_use_id, tool_name: row.tool_name, state: row.state });
    assert.deepEqual(offline.body.last_known.state.tool_requests, known.state.tool_requests.map(status));
    assert.equal(Object.hasOwn(offline.body.last_known.state.tool_requests[0], 'input'), false);
    for (const { route, body, method } of controls) assert.equal((await server.call(route, method, body)).status, 503);
  });


test('R4 prompt settlement waits past provider observation; control waits past acceptance', async () => {
  let calls = 0;
  const prompt = { async call() {
    calls++;
    return { body: { result: calls === 1 ? { state: 'provider_observed', outcome: null } :
      { state: 'completed', outcome: 'completed' } } };
  } };
  assert.equal((await settledPrompt(prompt, 'prompt-key')).outcome, 'completed');
  assert.equal(calls, 2);
  calls = 0;
  const control = { async call() {
    calls++;
    return { body: { result: { state: calls === 1 ? 'accepted' : 'done' } } };
  } };
  assert.equal((await settledControl(control, 'control-key')).state, 'done');
  assert.equal(calls, 2);
});
