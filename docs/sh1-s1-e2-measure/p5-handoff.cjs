'use strict';
// Phase 5: hand the session off to the terminal and run the generated command.
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const L = require('./lib.cjs');
(async () => {
  const id = L.state.sessionId;
  const report = {};
  await L.startBridge();
  const s = await L.snap(id);
  const inc = s.state.current_incarnation_id;
  const handoff = await L.call('/' + id + '/handoff', 'POST', { request_key: L.key(), incarnation_id: inc });
  L.log('handoff', handoff.status, handoff.body.acceptance, handoff.body.result?.state, handoff.body.result?.reason, handoff.body.code);
  const settled = await L.until(async () => {
    const v = await L.snap(id);
    const c = v.state.controls.find(x => x.request_key === handoff.body.request_key);
    return c && c.state !== 'accepted' && { v, c };
  }, 'handoff settled', 120000);
  const command = settled.v.state.handoff_command || settled.v.state.session?.handoff_command;
  report.handoff = { control: `${settled.c.state}/${settled.c.stage}/${settled.c.reason || ''}`, session: settled.v.state.session.state,
    hasCommand: typeof command === 'string' };
  L.log('handoff settled', report.handoff);
  if (typeof command !== 'string') { L.log('snapshot keys', Object.keys(settled.v.state)); throw new Error('no command'); }
  fs.writeFileSync(path.join(__dirname, 'handoff-command.txt'), command + '\n');
  L.log('command', command);
  // After handoff, the session is read-only.
  const refused = await L.call('/' + id + '/prompt', 'POST', { request_key: L.key(), incarnation_id: inc, body: 'should be refused' });
  report.promptAfterHandoff = `${refused.body.acceptance}/${refused.body.result?.state}/${refused.body.result?.reason || ''}`;
  // Non-interactive continuation check: append -p inside the /bin/sh -c string.
  if (!command.endsWith("'")) throw new Error('unexpected command shape');
  const probe = command.slice(0, -1) + ' -p "What was the first word you replied with in this conversation? Reply with that word only."' + "'";
  const run = spawnSync('/bin/zsh', ['-c', probe], { encoding: 'utf8', timeout: 180000, env: { ...process.env, ANTHROPIC_API_KEY: 'sk-ant-api03-SHOULD-NOT-REACH', CLAUDECODE: '1', PALANTIR_TOKEN: 'leak' } });
  report.resumeProbe = { status: run.status, stdout: run.stdout.trim().slice(0, 200), stderr: run.stderr.trim().slice(0, 300) };
  L.log('resume probe (polluted parent env)', report.resumeProbe);
  const cli = L.cliTranscriptUsers(L.state.claudeSessionId);
  report.cliPrompts = cli?.prompts;
  L.log('phase5 summary', report);
  fs.writeFileSync(path.join(__dirname, 'phase5.json'), JSON.stringify(report, null, 2));
  await L.stopBridge('SIGTERM');
  process.exit(0);
})().catch(async error => { L.log('ERROR', error.message); await L.stopBridge('SIGKILL'); process.exit(1); });
