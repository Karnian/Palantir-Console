#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
if (process.env.FAKE_ORCA_SPAWN_LOG) {
  fs.appendFileSync(process.env.FAKE_ORCA_SPAWN_LOG, JSON.stringify(args) + '\n');
}
if (process.env.FAKE_ORCA_STDERR) process.stderr.write(process.env.FAKE_ORCA_STDERR);
if (!['worktree ps --json', 'terminal list --json'].includes(args.join(' '))) process.exit(2);
const timestamp = Date.parse('2026-10-08T02:00:00.000Z');
const worktreeId = 'fixture-tree::/synthetic/repo';
const collection = args[0] === 'worktree' ? 'worktrees' : 'terminals';
const worktrees = [{
  worktreeId, path: '/synthetic/repo', branch: 'main', status: 'active',
  lastActivityAt: timestamp, liveTerminalCount: 1,
  displayName: 'FAKE_ORCA_PRIVATE_TEXT', comment: 'FAKE_ORCA_PRIVATE_TEXT', preview: 'FAKE_ORCA_PRIVATE_TEXT',
  agents: [{
    paneKey: 'fixture-tab:fixture-leaf', state: 'running', agentType: 'claude',
    stateStartedAt: timestamp, updatedAt: timestamp, prompt: 'Synthetic instruction A',
    taskTitle: 'FAKE_ORCA_PRIVATE_TEXT', lastAssistantMessage: 'FAKE_ORCA_PRIVATE_TEXT',
    toolInput: 'FAKE_ORCA_PRIVATE_TEXT'
  }]
}];
const terminals = [{
  handle: 'term_fixture', worktreeId, tabId: 'fixture-tab', leafId: 'fixture-leaf', agentIdentity: 'claude',
  lastOutputAt: timestamp, connected: true, title: 'FAKE_ORCA_PRIVATE_TEXT', preview: 'FAKE_ORCA_PRIVATE_TEXT'
}];
process.stdout.write(JSON.stringify({ id: 'fixture-response', ok: true,
  result: { [collection]: args[0] === 'worktree' ? worktrees : terminals,
    totalCount: 1, truncated: false, hostScope: {} }, _meta: {} }));
