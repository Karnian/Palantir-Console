'use strict';
// Phase 1: settings preview, start, one plain prompt, one approved tool.
const L = require('./lib.cjs');
(async () => {
  await L.startBridge();
  const preview = await L.call('/settings-preview', 'POST', { cwd: L.state.work });
  L.log('preview', preview.status, { ok: preview.body.ok, reason: preview.body.reason, warnings: preview.body.warnings,
    hooks: (preview.body.hooks || []).length, mcp: (preview.body.mcp_servers || []).map(m => m.name) });
  if (!preview.body.ok) throw new Error('preview not ok');
  const started = await L.call('/start', 'POST', { request_key: L.key(), cwd: L.state.work, confirmed_settings: true });
  L.log('start', started.status, started.body.acceptance, started.body.result?.state, started.body.code);
  const id = started.body.result.session_id;
  L.state.sessionId = id; L.save();
  const ready = await L.until(async () => {
    const s = await L.snap(id);
    const control = (s.state?.controls || []).find(c => c.kind === 'start');
    if (control && control.state !== 'accepted') return { s, control };
    return false;
  }, 'start control settled', 120000);
  L.log('start settled', ready.control, L.summarize(ready.s));
  if (ready.control.state !== 'done') throw new Error('start failed');
  const inc = ready.s.state.current_incarnation_id;
  const prompt = await L.call('/' + id + '/prompt', 'POST', { request_key: L.key(), incarnation_id: inc, body: 'Reply with exactly the word: alpha' });
  L.log('prompt', prompt.status, prompt.body.acceptance, prompt.body.result?.state);
  const done = await L.until(async () => {
    const s = await L.snap(id);
    const d = (s.state.deliveries || []).find(x => x.id === prompt.body.result.id);
    return d && d.outcome ? { s, d } : false;
  }, 'prompt outcome', 180000);
  L.log('prompt done', done.d.state, done.d.outcome, L.summarize(done.s));
  L.state.claudeSessionId = done.s.state.session.claude_session_id; L.save();
  await L.stopBridge('SIGTERM');
  L.log('phase1 ok');
  process.exit(0);
})().catch(async error => { L.log('ERROR', error.message); await L.stopBridge('SIGKILL'); process.exit(1); });
