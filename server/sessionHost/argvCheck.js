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
    const verdict = checkExecutable(command, pinnedPath);
    if (verdict) return fail(verdict);
    if (!/^[a-f0-9]{64}$/.test(pinnedSha256) || await (options.hashFile || hashFile)(command) !== pinnedSha256) {
      return fail('executable_hash_mismatch');
    }
    return checkArgs(args);
  } catch {
    return fail('executable_check_failed');
  }
}
function checkArgs(args) {
  const fail = reason => ({ ok: false, reason });
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
}
function hashFileSync(file) {
  const hash = createHash('sha256');
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  const fd = fs.openSync(file, 'r');
  try {
    let count;
    while ((count = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0) hash.update(buffer.subarray(0, count));
    return hash.digest('hex');
  } finally {
    fs.closeSync(fd);
  }
}
function checkSpawnOptionsSync({ command, args } = {}, options = {}) {
  const fail = reason => ({ ok: false, reason });
  try {
    const verdict = checkExecutable(command, options.pinnedPath);
    if (verdict) return fail(verdict);
    if (!/^[a-f0-9]{64}$/.test(options.pinnedSha256) ||
        (options.hashFileSync || hashFileSync)(command) !== options.pinnedSha256) return fail('executable_hash_mismatch');
    return checkArgs(args);
  } catch {
    return fail('executable_check_failed');
  }
}
function checkExecutable(command, pinnedPath) {
  if (typeof command !== 'string' || typeof pinnedPath !== 'string' || !path.isAbsolute(command) || !path.isAbsolute(pinnedPath) ||
      fs.realpathSync(command) !== fs.realpathSync(pinnedPath)) return 'executable_mismatch';
  return null;
}
module.exports = { checkSpawnOptions, checkSpawnOptionsSync, hashFile, hashFileSync };
