import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
const require = createRequire(import.meta.url);
const policy = require('../../server/services/observeSnapshotPolicy.js');
const { computeReaderBuild } = require('./sessionSnapshotLauncher.cjs');
const { assertSpawnAllowed } = require('../../server/utils/spawnGuard.js');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const MANIFEST = Object.freeze([
  'scripts/lib/sessionSnapshotLauncher.cjs', 'scripts/lib/sessionSnapshotReader.cjs',
  'server/services/memorySanitize.js', 'server/services/observeSnapshotPolicy.js'
]);
const builtins = ['node:fs', 'node:path', 'node:os', 'node:crypto', 'node:child_process'];
function resolveModule(from, spec) {
  if (builtins.includes(spec)) return spec;
  if (!spec.startsWith('.')) return null;
  const name = path.posix.normalize(path.posix.join(path.posix.dirname(from), spec));
  return [name, name + '.js', name + '.cjs'].find(value => MANIFEST.includes(value)) || null;
}
function rejectBundle() {
  const error = new Error('bundle_rejected');
  error.code = 'bundle_rejected';
  throw error;
}
function checkSource(name, source) {
  if (/module\s*\.\s*require|\bimport\b|process\s*\.\s*binding/.test(source)) rejectBundle();
  if (/\b(?:getBuiltinModule|createRequire)\b|process\s*\.\s*dlopen\b/.test(source)) rejectBundle();
  for (const match of source.matchAll(/\brequire\s*\(\s*([^)]*)\)/g)) {
    const literal = /^(['"])([^'"\n]*)\1\s*$/.exec(match[1]);
    if (!literal || !resolveModule(name, literal[2])) rejectBundle();
  }
}
export function buildBundle({ request, sourceOverrides = {} }) {
  const sources = {};
  for (const name of MANIFEST) {
    sources[name] = sourceOverrides[name] ?? fs.readFileSync(path.join(root, name), 'utf8');
    checkSource(name, sources[name]);
  }
  const readerBuild = computeReaderBuild(sources);
  const runtime = `
(function snapshotRuntime(request) {
  'use strict';
  const nativeRequire = require;
  if (typeof process.getBuiltinModule === 'function') delete process.getBuiltinModule;
  const runtimeGlobal = typeof globalThis !== 'undefined' ? globalThis : global;
  const BUILTINS = Object.create(null);
  ${JSON.stringify(builtins)}.forEach(function allowBuiltin(name) { BUILTINS[name] = true; });
  ['require', 'module', 'exports', '__filename', '__dirname'].forEach(function removeGlobal(name) {
    if (Object.prototype.hasOwnProperty.call(runtimeGlobal, name)) delete runtimeGlobal[name];
  });
  const registry = ${JSON.stringify(sources)};
  const cache = {};
  function load(name) {
    if (cache[name]) return cache[name].exports;
    const module = { exports: {} };
    cache[name] = module;
    function resolve(spec) {
      if (BUILTINS[spec] === true) return nativeRequire(spec);
      if (!spec.startsWith('.')) throw new Error('module_rejected');
      const path = nativeRequire('node:path').posix;
      const base = path.normalize(path.join(path.dirname(name), spec));
      const target = [base, base + '.js', base + '.cjs'].find(function registered(key) {
        return Object.prototype.hasOwnProperty.call(registry, key);
      });
      if (!target) throw new Error('module_rejected');
      return load(target);
    }
    // Spec §2.3: compile in global scope without exposing runtime closures.
    const body = "'use strict';\\n" + registry[name];
    if (name === 'scripts/lib/sessionSnapshotLauncher.cjs') {
      const launch = new Function('module', 'exports', 'require', 'REQUEST', 'BUNDLE_SOURCES', body);
      launch(module, module.exports, resolve, request, registry);
    } else {
      const execute = new Function('module', 'exports', 'require', body);
      execute(module, module.exports, resolve);
    }
    return module.exports;
  }
  load('scripts/lib/sessionSnapshotLauncher.cjs');
})(REQUEST);
`;
  return { code: `const REQUEST = ${JSON.stringify(request)};\n${runtime}`, readerBuild };
}
export function runExecutor({ target, bundle, sshBin = 'ssh', env = process.env,
  maxStdoutBytes = 16 * 1024 * 1024, timeoutMs = 120000, spawnImpl = spawn }) {
  const command = target.kind === 'local' ? process.execPath : resolveExecutable(sshBin, env);
  const args = target.kind === 'local' ? ['--no-warnings', '-']
    : ['-o', 'BatchMode=yes', '--', target.host, target.remoteNode || 'node', '--no-warnings', '-'];
  assertSpawnAllowed({ command, source: 'session-snapshot:executor' });
  return new Promise((resolve, reject) => {
    const child = spawnImpl(command, args, { shell: false, env, stdio: ['pipe', 'pipe', 'pipe'] });
    const chunks = [];
    let bytes = 0;
    let stderrBytes = 0;
    let killedReason = null;
    function kill(reason) {
      if (!killedReason) { killedReason = reason; child.kill('SIGKILL'); }
    }
    const timer = setTimeout(() => kill('timeout'), timeoutMs);
    child.stdout.on('data', chunk => {
      bytes += chunk.length;
      if (bytes > maxStdoutBytes) kill('stdout_limit');
      else chunks.push(chunk);
    });
    child.stderr.on('data', chunk => { stderrBytes += chunk.length; });
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', (exitCode, signal) => {
      clearTimeout(timer);
      resolve({ exitCode, signal, stdout: Buffer.concat(chunks), stderrBytes, killedReason });
    });
    child.stdin.on('error', function ignorePipeError() {});
    child.stdin.end(typeof bundle === 'string' ? bundle : bundle.code);
  });
}
function resolveExecutable(command, env) {
  if (path.isAbsolute(command)) return command;
  for (const directory of (env.PATH || '').split(path.delimiter)) {
    const candidate = path.resolve(directory, command);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      if (fs.statSync(candidate).isFile()) return fs.realpathSync(candidate);
    } catch {}
  }
  const error = new Error('executor_not_found');
  error.code = 'ENOENT';
  throw error;
}
export function receiveEnvelope(result, { expectedKinds, expectedReaderBuild }) {
  if (result.exitCode !== 0 || result.killedReason !== null) {
    return { ok: false, reason: 'executor_failed' };
  }
  try {
    const text = result.stdout.toString('utf8');
    if (text.trim() !== text.replace(/\n$/, '')) return { ok: false, reason: 'invalid_json' };
    const envelope = JSON.parse(text);
    const kinds = {
      'palantir.session-snapshot/1': ['snapshot', policy.validateSnapshot],
      'palantir.snapshot-status/1': ['status', policy.validateStatusEnvelope],
      'palantir.snapshot-exclude-preview/1': ['preview', policy.validateExcludePreview]
    };
    const entry = kinds[envelope.schema];
    if (!entry || !expectedKinds.includes(entry[0]) || !entry[1](envelope).ok
      || envelope.reader_build !== expectedReaderBuild) return { ok: false, reason: 'invalid_envelope' };
    return { ok: true, kind: entry[0], envelope };
  } catch { return { ok: false, reason: 'invalid_json' }; }
}
export function writeSnapshotAtomic(outDir, envelope) {
  if (!policy.validateSnapshot(envelope).ok || !policy.ID_RE.test(envelope.machine.id)) {
    throw new Error('invalid_snapshot');
  }
  fs.mkdirSync(outDir, { recursive: true, mode: 0o700 });
  fs.chmodSync(outDir, 0o700);
  const destination = path.join(outDir, envelope.machine.id + '.json');
  const nonce = crypto.randomBytes(8).toString('hex');
  const temporary = path.join(outDir, '.' + envelope.machine.id + '-' + process.pid + '-' + nonce + '.tmp');
  let created = false;
  try {
    const descriptor = fs.openSync(temporary, 'wx', 0o600);
    created = true;
    try { fs.writeFileSync(descriptor, JSON.stringify(envelope) + '\n'); }
    finally { fs.closeSync(descriptor); }
    fs.renameSync(temporary, destination);
  } catch (error) {
    if (created) { try { fs.unlinkSync(temporary); } catch {} }
    throw error;
  }
  return destination;
}
