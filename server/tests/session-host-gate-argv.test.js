'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { checkSpawnOptions, hashFile } = require('../sessionHost/argvCheck');
const args = ['--output-format', 'stream-json', '--verbose', '--input-format', 'stream-json', '--permission-mode=default'];
test('measured argv passes; every forbidden flag has same-input passing control', async () => {
  const options = { pinnedPath: process.execPath, pinnedSha256: 'a'.repeat(64), hashFile: async () => 'a'.repeat(64) };
  const good = { command: process.execPath, args };
  for (const extra of [['--bare'], ['--dangerously-skip-permissions'], ['--permission-mode=bypassPermissions'],
    ['--permission-mode', 'bypassPermissions'], ['--allow-dangerously-skip-permissions']]) {
    assert.equal((await checkSpawnOptions(good, options)).ok, true);
    assert.equal((await checkSpawnOptions({ ...good, args: [...args, ...extra] }, options)).ok, false);
  }
  for (const badArgs of [args.slice(0, -1), [...args, '--permission-mode=default']]) {
    assert.equal((await checkSpawnOptions(good, options)).ok, true);
    assert.equal((await checkSpawnOptions({ ...good, args: badArgs }, options)).ok, false);
  }
  assert.equal((await checkSpawnOptions({ ...good, command: '/bin/ps' }, options)).ok, false);
  assert.equal((await checkSpawnOptions(good, { ...options, hashFile: () => 'b'.repeat(64) })).ok, false);
});
test('default streaming SHA-256 verifies an actual executable without running it', async () => {
  const digest = await hashFile(process.execPath);
  assert.equal((await checkSpawnOptions({ command: process.execPath, args }, { pinnedPath: process.execPath, pinnedSha256: digest })).ok, true);
});
