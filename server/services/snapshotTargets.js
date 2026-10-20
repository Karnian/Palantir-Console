'use strict';

const { isSafeId } = require('./observeSnapshotPolicy');
const KEYS = ['name', 'kind', 'host', 'machineId', 'label', 'remoteNode', 'orcaBin', 'orca'];
const LABEL = /^[A-Za-z0-9._][A-Za-z0-9._-]{0,31}$/;
const ABSOLUTE = /^\/[A-Za-z0-9._/-]+$/;
const fail = (code, status = 400) => Object.assign(new Error(code), { code, status });

function parseSnapshotTargets(raw) {
  const values = JSON.parse(raw || '[]');
  if (!Array.isArray(values)) throw fail('snapshot_targets_invalid');
  const names = new Set(); const ids = new Set();
  return values.map(value => {
    if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).some(key => !KEYS.includes(key))
      || Object.hasOwn(value, 'orca') && value.orca !== true
      || typeof value.name !== 'string' || !LABEL.test(value.name)
      || typeof value.machineId !== 'string' || !isSafeId(value.machineId)
      || !['local', 'ssh'].includes(value.kind) || names.has(value.name) || ids.has(value.machineId)) {
      throw fail('snapshot_targets_invalid');
    }
    if (value.kind === 'ssh') {
      if (typeof value.host !== 'string' || !/^[A-Za-z0-9._][A-Za-z0-9._-]*(?:@[A-Za-z0-9._-]+)?$/.test(value.host)) {
        throw fail('snapshot_targets_invalid');
      }
    } else if (value.host !== undefined || value.remoteNode !== undefined) throw fail('snapshot_targets_invalid');
    if (value.label !== undefined && (typeof value.label !== 'string' || !LABEL.test(value.label))) {
      throw fail('snapshot_targets_invalid');
    }
    for (const key of ['remoteNode', 'orcaBin']) {
      if (value[key] !== undefined && (typeof value[key] !== 'string' || !ABSOLUTE.test(value[key]))) {
        throw fail('snapshot_targets_invalid');
      }
    }
    names.add(value.name); ids.add(value.machineId);
    return Object.freeze({ ...value });
  });
}

module.exports = { parseSnapshotTargets };
