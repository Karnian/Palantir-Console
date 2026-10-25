'use strict';
// Phase 3: server restart while an approval is pending (SIGTERM, SIGKILL), two tabs answering the
// same card, and two tabs submitting prompts at the same instant.
const L = require('./lib.cjs');
async function waitOutcome(id, pid, label) {
  return L.until(async () => {
    const s = await L.snap(id);
    const d = s.state.deliveries.find(x => x.id === pid);
    return d && d.outcome ? { s, d } : false;
  }, label, 240000);
}
(async () => {
  const id = L.state.sessionId;
  const report = {};
  for (const signal of ['SIGTERM', 'SIGKILL']) {
    await L.startBridge();
    const before = L.counter().length;
    let s = await L.snap(id);
    const inc = s.state.current_incarnation_id;
    const tag = `restart_${signal}`;
    const prompt = await L.call('/' + id + '/prompt', 'POST', { request_key: L.key(), incarnation_id: inc,
      body: `Use the Bash tool to run exactly this command: echo ${tag} >> counter.txt  Then reply with the word done.` });
    const pid = prompt.body.result.id;
    const card = await L.until(async () => ((await L.snap(id)).state.tool_requests || []).find(t => t.state === 'pending'), `${tag} card`);
    await L.stopBridge(signal);
    L.log(`${tag}: bridge stopped while card pending`, card.tool_use_id);
    await new Promise(resolve => setTimeout(resolve, 3000));
    await L.startBridge();
    s = await L.snap(id);
    const stillPending = (s.state.tool_requests || []).find(t => t.tool_use_id === card.tool_use_id);
    L.log(`${tag}: after restart`, { host: s.host, card: stillPending?.state, counterDelta: L.counter().length - before });
    const answer = await L.call('/' + id + '/tool-decision', 'POST', { request_key: L.key(), incarnation_id: inc,
      tool_use_id: card.tool_use_id, behavior: 'allow' });
    const done = await waitOutcome(id, pid, `${tag} outcome`);
    const t = done.s.state.deliveries.find(x => x.id === answer.body.result.id);
    report[tag] = { cardAfterRestart: stillPending?.state, prompt: `${done.d.state}/${done.d.outcome}`,
      decision: `${t.state}/${t.reason || ''}`, counterNew: L.counter().slice(before) };
    L.log(tag, report[tag]);
    await L.stopBridge('SIGTERM');
  }

  // Two tabs answer the same card with different keys.
  await L.startBridge();
  {
    const before = L.counter().length;
    const s = await L.snap(id);
    const inc = s.state.current_incarnation_id;
    const prompt = await L.call('/' + id + '/prompt', 'POST', { request_key: L.key(), incarnation_id: inc,
      body: 'Use the Bash tool to run exactly this command: echo two_tabs_card >> counter.txt  Then reply with the word done.' });
    const card = await L.until(async () => ((await L.snap(id)).state.tool_requests || []).find(t => t.state === 'pending'), 'two-tab card');
    const [a, b] = await Promise.all(['allow', 'deny'].map(behavior => L.call('/' + id + '/tool-decision', 'POST',
      { request_key: L.key(), incarnation_id: inc, tool_use_id: card.tool_use_id, behavior, message: 'Denied by second tab.' })));
    const done = await waitOutcome(id, prompt.body.result.id, 'two-tab card outcome');
    report.twoTabsCard = { a: `${a.body.acceptance}/${a.body.result?.state}/${a.body.result?.reason || ''}`,
      b: `${b.body.acceptance}/${b.body.result?.state}/${b.body.result?.reason || ''}`,
      prompt: `${done.d.state}/${done.d.outcome}`, counterNew: L.counter().slice(before) };
    L.log('twoTabsCard', report.twoTabsCard);
  }
  // Two tabs submit prompts at the same instant while idle.
  {
    const s = await L.snap(id);
    const inc = s.state.current_incarnation_id;
    const [a, b] = await Promise.all(['tab-a', 'tab-b'].map(word => L.call('/' + id + '/prompt', 'POST',
      { request_key: L.key(), incarnation_id: inc, body: `Reply with exactly the word: ${word.replace('-', '')}` })));
    const ids = [a, b].map(r => r.body.result?.id).filter(Boolean);
    const outcomes = [];
    for (const pid of ids) outcomes.push((await waitOutcome(id, pid, 'two-tab prompt')).d);
    const final = await L.snap(id);
    const incRow = final.state.incarnations.find(i => i.id === inc);
    report.twoTabsPrompt = { a: `${a.body.acceptance}/${a.body.result?.state}`, b: `${b.body.acceptance}/${b.body.result?.state}`,
      outcomes: outcomes.map(d => `${d.state}/${d.outcome}/turn${d.turn_gen}`), attributionUncertain: incRow.attribution_uncertain };
    L.log('twoTabsPrompt', report.twoTabsPrompt);
  }
  const cli = L.cliTranscriptUsers(L.state.claudeSessionId);
  L.log('phase3 summary', report, { cliPrompts: cli?.prompts });
  await L.stopBridge('SIGTERM');
  process.exit(0);
})().catch(async error => { L.log('ERROR', error.message); await L.stopBridge('SIGKILL'); process.exit(1); });
