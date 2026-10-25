'use strict';
// Phase 4: interrupt a running tool; SIGKILL the host mid-turn, recover, close the orphan, resume, prompt.
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const L = require('./lib.cjs');
const hostPid = () => {
  try {
    const out = execFileSync('/usr/bin/pgrep', ['-f', 'sessionHost/main.js --runtime-dir ' + L.state.runtimeDir], { encoding: 'utf8' });
    return out.split('\n').filter(Boolean).map(Number);
  } catch { return []; }
};
async function outcome(id, pid, label, timeout = 240000) {
  return L.until(async () => {
    const s = await L.snap(id);
    const d = s.state?.deliveries?.find(x => x.id === pid);
    return d && d.outcome ? { s, d } : false;
  }, label, timeout);
}
(async () => {
  const id = L.state.sessionId;
  const report = {};
  await L.startBridge();
  // Interrupt during a running tool.
  {
    const before = L.counter().length;
    const s = await L.snap(id);
    const inc = s.state.current_incarnation_id;
    const prompt = await L.call('/' + id + '/prompt', 'POST', { request_key: L.key(), incarnation_id: inc,
      body: 'Use the Bash tool to run exactly this command: python3 -c "import time; time.sleep(40)" && echo interrupted_tool >> counter.txt  Then reply with the word done.' });
    const card = await L.until(async () => ((await L.snap(id)).state.tool_requests || []).find(t => t.state === 'pending'), 'interrupt card');
    await L.call('/' + id + '/tool-decision', 'POST', { request_key: L.key(), incarnation_id: inc, tool_use_id: card.tool_use_id, behavior: 'allow' });
    await new Promise(resolve => setTimeout(resolve, 5000));
    const interrupt = await L.call('/' + id + '/interrupt', 'POST', { request_key: L.key(), incarnation_id: inc });
    const done = await outcome(id, prompt.body.result.id, 'interrupted prompt outcome', 120000);
    await new Promise(resolve => setTimeout(resolve, 45000)); // the tool would have written by now if it kept running
    const after = await L.snap(id);
    const intr = after.state.deliveries.find(x => x.id === interrupt.body.result.id);
    const incRow = after.state.incarnations.find(i => i.id === inc);
    report.interrupt = { prompt: `${done.d.state}/${done.d.outcome}`, interrupt: `${intr.state}/${intr.reason || ''}`,
      counterNew: L.counter().slice(before), interruptUnknown: incRow.interrupt_unknown, attributionUncertain: incRow.attribution_uncertain };
    L.log('interrupt', report.interrupt);
    // Next turn after the interrupt must still work normally.
    const next = await L.call('/' + id + '/prompt', 'POST', { request_key: L.key(), incarnation_id: inc, body: 'Reply with exactly the word: afterinterrupt' });
    const nextDone = await outcome(id, next.body.result.id, 'after-interrupt prompt');
    report.afterInterrupt = `${nextDone.d.state}/${nextDone.d.outcome}`;
    L.log('afterInterrupt', report.afterInterrupt);
  }
  // Host SIGKILL during a turn with a running tool.
  {
    const before = L.counter().length;
    const s = await L.snap(id);
    const inc = s.state.current_incarnation_id;
    const childPid = s.state.incarnations.find(i => i.id === inc).pid;
    const prompt = await L.call('/' + id + '/prompt', 'POST', { request_key: L.key(), incarnation_id: inc,
      body: 'Use the Bash tool to run exactly this command: python3 -c "import time; time.sleep(15)" && echo orphan_tool >> counter.txt  Then reply with the word done.' });
    const card = await L.until(async () => ((await L.snap(id)).state.tool_requests || []).find(t => t.state === 'pending'), 'hostkill card');
    await L.call('/' + id + '/tool-decision', 'POST', { request_key: L.key(), incarnation_id: inc, tool_use_id: card.tool_use_id, behavior: 'allow' });
    await new Promise(resolve => setTimeout(resolve, 3000));
    const pids = hostPid();
    L.log('host pids', pids, 'child pid', childPid);
    for (const pid of pids) process.kill(pid, 'SIGKILL');
    await new Promise(resolve => setTimeout(resolve, 2000));
    const offline = await L.snap(id);
    L.log('after host kill (bridge view)', { host: offline.host, known: offline.current_state_known, asOf: !!offline.as_of });
    let childAlive; try { process.kill(childPid, 0); childAlive = true; } catch { childAlive = false; }
    L.log('child alive right after host kill', childAlive);
    // Wait for the orphan to finish its turn (S1-0 ⑤), then bring the host back via a mutation-free read + ensure.
    await new Promise(resolve => setTimeout(resolve, 30000));
    const orphanCounter = L.counter().slice(before);
    let childAliveLater; try { process.kill(childPid, 0); childAliveLater = true; } catch { childAliveLater = false; }
    // A mutation brings the host back; use a harmless settings preview.
    await L.call('/settings-preview', 'POST', { cwd: L.state.work });
    const recovered = await L.until(async () => { const v = await L.snap(id); return v.host === 'running' && v; }, 'host back');
    const old = recovered.state.incarnations.find(i => i.id === inc);
    const d = recovered.state.deliveries.find(x => x.id === prompt.body.result.id);
    report.hostKill = { childAliveAfterKill: childAlive, childAliveAfter30s: childAliveLater, orphanCounter,
      incarnationAfterRecovery: `${old.state}/${old.end_reason || ''}`, prompt: `${d.state}/${d.outcome || ''}` };
    L.log('hostKill', report.hostKill, L.summarize(recovered));
    // Close (if orphaned) then resume.
    if (old.state === 'orphaned') {
      const close = await L.call('/' + id + '/stop', 'POST', { request_key: L.key() });
      L.log('stop orphan', close.body.acceptance, close.body.result?.state, close.body.result?.reason);
      await L.until(async () => { const v = await L.snap(id); const c = v.state.controls.find(x => x.request_key === close.body.request_key); return c && c.state !== 'accepted' && c; }, 'stop settled');
    }
    const resume = await L.call('/' + id + '/resume', 'POST', { request_key: L.key() });
    const resumed = await L.until(async () => { const v = await L.snap(id); const c = v.state.controls.find(x => x.request_key === resume.body.request_key); return c && c.state !== 'accepted' && { v, c }; }, 'resume settled', 120000);
    report.resume = `${resumed.c.state}/${resumed.c.reason || ''}`;
    L.log('resume', report.resume, L.summarize(resumed.v));
    if (resumed.c.state === 'done') {
      const inc2 = resumed.v.state.current_incarnation_id;
      const p = await L.call('/' + id + '/prompt', 'POST', { request_key: L.key(), incarnation_id: inc2, body: 'What was the first word you replied with in this conversation? Reply with that word only.' });
      const pd = await outcome(id, p.body.result.id, 'post-resume prompt');
      report.postResume = `${pd.d.state}/${pd.d.outcome}`;
      L.log('postResume', report.postResume);
    }
  }
  const cli = L.cliTranscriptUsers(L.state.claudeSessionId);
  L.log('phase4 summary', report, { cliPrompts: cli?.prompts });
  fs.writeFileSync(path.join(__dirname, 'phase4.json'), JSON.stringify(report, null, 2));
  await L.stopBridge('SIGTERM');
  process.exit(0);
})().catch(async error => { L.log('ERROR', error.message); await L.stopBridge('SIGKILL'); process.exit(1); });
