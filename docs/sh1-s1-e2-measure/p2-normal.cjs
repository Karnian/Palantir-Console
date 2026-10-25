'use strict';
// Phase 2: normal path minimum — 20 prompts, 10 of them with one approved Bash tool. unknown must be 0.
const L = require('./lib.cjs');
(async () => {
  await L.startBridge();
  const id = L.state.sessionId;
  const before = L.counter().length;
  const results = [];
  for (let n = 1; n <= 20; n++) {
    const s0 = await L.snap(id);
    const inc = s0.state.current_incarnation_id;
    const withTool = n % 2 === 0;
    const body = withTool
      ? `Use the Bash tool to run exactly this command: echo n${n} >> counter.txt  Then reply with the word done.`
      : `Reply with exactly the word: w${n}`;
    const prompt = await L.call('/' + id + '/prompt', 'POST', { request_key: L.key(), incarnation_id: inc, body });
    if (prompt.body.acceptance !== 'accepted') throw new Error('prompt not accepted ' + JSON.stringify(prompt.body).slice(0, 300));
    const pid = prompt.body.result.id;
    let decision = null;
    if (withTool) {
      const card = await L.until(async () => {
        const s = await L.snap(id);
        const d = s.state.deliveries.find(x => x.id === pid);
        if (d?.outcome) return { finishedWithoutCard: d };
        return (s.state.tool_requests || []).find(t => t.state === 'pending') || false;
      }, `card ${n}`, 180000);
      if (card.finishedWithoutCard) {
        L.log(`n${n} finished without a permission card`, card.finishedWithoutCard);
      } else {
        const answer = await L.call('/' + id + '/tool-decision', 'POST', { request_key: L.key(), incarnation_id: inc,
          tool_use_id: card.tool_use_id, behavior: 'allow' });
        decision = answer.body.result?.id;
      }
    }
    const done = await L.until(async () => {
      const s = await L.snap(id);
      const d = s.state.deliveries.find(x => x.id === pid);
      return d && d.outcome ? s : false;
    }, `prompt ${n} outcome`, 240000);
    const d = done.state.deliveries.find(x => x.id === pid);
    const t = decision && done.state.deliveries.find(x => x.id === decision);
    results.push({ n, prompt: `${d.state}/${d.outcome}`, decision: t ? `${t.state}/${t.reason || ''}` : null });
    L.log(`n${n}`, results.at(-1));
  }
  const final = await L.snap(id);
  const counterLines = L.counter().slice(before);
  const cli = L.cliTranscriptUsers(L.state.claudeSessionId);
  const unknown = results.filter(r => r.prompt.includes('unknown') || (r.decision && !r.decision.startsWith('provider_observed')));
  L.log('phase2 summary', { prompts: results.length, approvals: results.filter(r => r.decision).length, unknown: unknown.length,
    counterNew: counterLines, cliPrompts: cli?.prompts, summary: L.summarize(final) });
  await L.stopBridge('SIGTERM');
  process.exit(unknown.length ? 2 : 0);
})().catch(async error => { L.log('ERROR', error.message); await L.stopBridge('SIGKILL'); process.exit(1); });
