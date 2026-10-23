'use strict';
const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const { assertSpawnAllowed } = require('../../utils/spawnGuard');

function assertSafeShellFixture(script) {
  assert.doesNotMatch(script, /security|curl|\.credentials\.json|claudeAiOauth|find-generic-password/i,
    'credential commands and readers must be rejected before executing a generated shell');
}

function runGuardedShellFixture(script, { directory, env = {}, spawnSync = childProcess.spawnSync }) {
  assertSafeShellFixture(script);
  assertSpawnAllowed({ command: process.execPath, source: 'guarded-shell-fixture' });
  const runner = `const fs=require('node:fs'),cp=require('node:child_process');
const input=JSON.parse(fs.readFileSync(0,'utf8'));
const result=cp.spawnSync('/bin/sh',['-c',input.script],{cwd:input.directory,env:process.env,encoding:'utf8',timeout:5000});
process.stdout.write(JSON.stringify({status:result.status,stdout:result.stdout,stderr:result.stderr,error:result.error&&result.error.message}));`;
  const childEnv = { PATH: directory, HOME: directory };
  for (const key of ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY']) {
    if (env[key] !== undefined) childEnv[key] = env[key];
  }
  const result = spawnSync(process.execPath, ['-e', runner], {
    input: JSON.stringify({ script, directory }), encoding: 'utf8', timeout: 10000,
    // Never inherit host credentials, NODE_OPTIONS, HOME or the host PATH.
    env: childEnv, cwd: directory,
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

module.exports = { assertSafeShellFixture, runGuardedShellFixture };
