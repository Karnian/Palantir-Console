#!/usr/bin/env node
const fs = require('node:fs');
const originalAppend = fs.appendFileSync;
function record(target) {
  if (process.env.WRITE_PROBE_LOG && String(target) !== process.env.WRITE_PROBE_LOG) {
    originalAppend(process.env.WRITE_PROBE_LOG, JSON.stringify(String(target)) + '\n');
  }
}
function wrap(object, name, open) {
  const original = object[name];
  if (!original) return;
  object[name] = function probe(target, ...args) {
    if (!open || typeof args[0] === 'string' && /[wa+]/.test(args[0])
      || typeof args[0] === 'number' && (args[0] & (fs.constants.O_WRONLY | fs.constants.O_RDWR))) record(target);
    if (name.startsWith('rename') || name.startsWith('copyFile')) record(args[0]);
    return original.call(this, target, ...args);
  };
}
for (const name of ['writeFile', 'appendFile', 'rename', 'unlink', 'rm', 'mkdir', 'copyFile']) {
  wrap(fs, name, false);
  wrap(fs, name + 'Sync', false);
  wrap(fs.promises, name, false);
}
wrap(fs, 'open', true);
wrap(fs, 'openSync', true);
wrap(fs.promises, 'open', true);
