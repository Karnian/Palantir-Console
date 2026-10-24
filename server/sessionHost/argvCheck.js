'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
async function hashFile(file) {
  const hash = createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}
async function checkSpawnOptions({ command, args } = {}, options = {}) {
  const fail = reason => ({ ok: false, reason });
  const { pinnedPath, pinnedSha256 } = options;
  try {
    if (typeof command !== 'string' || typeof pinnedPath !== 'string' || !path.isAbsolute(command) || !path.isAbsolute(pinnedPath) ||
        fs.realpathSync(command) !== fs.realpathSync(pinnedPath)) return fail('executable_mismatch');
    if (!/^[a-f0-9]{64}$/.test(pinnedSha256) || await (options.hashFile || hashFile)(command) !== pinnedSha256) {
      return fail('executable_hash_mismatch');
    }
    if (!Array.isArray(args) || !args.every(arg => typeof arg === 'string' && !arg.includes('\0'))) return fail('unsafe_argv');
    const forbidden = ['--bare', '--dangerously-skip-permissions', '--allow-dangerously-skip-permissions'];
    for (let index = 0; index < args.length; index++) {
      const arg = args[index];
      if (forbidden.some(flag => arg === flag || arg.startsWith(`${flag}=`))) return fail('unsafe_argv');
      if (arg === '--permission-mode' || (arg.startsWith('--permission-mode=') && arg !== '--permission-mode=default')) {
        return fail('unsafe_argv');
      }
    }
    if (args.filter(arg => arg === '--permission-mode=default').length !== 1 || args.includes('--')) return fail('unsafe_argv');
    return { ok: true };
  } catch {
    return fail('executable_check_failed');
  }
}
module.exports = { checkSpawnOptions, hashFile };
