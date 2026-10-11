#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const { spawn } = require('node:child_process');
const cwd = fs.realpathSync(process.cwd());
const directory = path.join(process.env.HOME, '.claude/projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'));
const send = value => process.stdout.write(`${JSON.stringify(value)}\n`);
const input = readline.createInterface({ input: process.stdin });
const noTranscript = process.argv.includes('--fixture-no-transcript');
const noMemoryPaths = noTranscript || process.argv.includes('--fixture-no-memory-paths');
if (process.argv.includes('--fixture-stubborn-child')) {
  const program = "process.on('SIGTERM',()=>{});process.send('ready');setInterval(()=>{},1000)";
  const child = spawn(process.execPath, ['-e', program], {
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'], detached: false,
  });
  child.once('message', () => fs.writeFileSync(path.join(cwd, 'child-pid'), String(child.pid)));
  process.on('SIGTERM', () => process.exit(0));
}
const init = { type: 'system', subtype: 'init', session_id: 'fixture-session' };
if (!noMemoryPaths) init.memory_paths = { auto: `${directory}/memory/` };
send(init);
input.on('line', line => {
  const request = JSON.parse(line);
  const text = request.message.content.split('\n\n').at(-1);
  if (text === 'hook') return send({ type: 'system', subtype: 'hook_started' });
  if (text === 'timeout') return;
  if (!noTranscript) {
    fs.mkdirSync(directory, { recursive: true });
    fs.appendFileSync(path.join(directory, 'fixture-session.jsonl'), `${JSON.stringify({ cwd, text })}\n`);
  }
  send({ type: 'assistant', message: { content: [
    { type: 'tool_use', name: 'mcp__session_hub__list_sessions', input: { limit: 1 } },
    { type: 'text', text: 'fixture answer' },
  ] } });
  send({ type: 'result', is_error: false, usage: { input_tokens: text === 'rotate' ? 120001 : 1 } });
  if (text === 'late') setTimeout(() => send({ type: 'assistant', message: {
    content: [{ type: 'text', text: 'late output' }],
  } }), 30);
});
