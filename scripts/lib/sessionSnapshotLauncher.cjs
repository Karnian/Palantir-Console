// Spec §2.3: suppress diagnostics before loading any source module.
if (typeof REQUEST !== 'undefined') {
  process.stderr.write = function discardStderr() { return true; };
  process.removeAllListeners('warning');
  process.on('warning', function discardWarning() {});
  process.on('uncaughtException', launcherFailure);
  process.on('unhandledRejection', launcherFailure);
  var originalStdoutWrite = process.stdout.write;
  process.stdout.write = function trackStdout() {
    launcherWrote = true;
    return originalStdoutWrite.apply(process.stdout, arguments);
  };
}
var launcherWrote = false;
var launcherBuild = '0000000000000000';
function launcherFailure() {
  if (launcherWrote) process.exit(1);
  else launcherEmit(launcherStatus('internal_error'), 1);
}
function launcherStatus(code) {
  return { schema: 'palantir.snapshot-status/1', machine_id: 'unknown',
    reader_build: launcherBuild, code: code, counts: {} };
}
function launcherEmit(value, exitCode) {
  if (launcherWrote) return;
  var encoded = JSON.stringify(value) + '\n';
  process.stdout.write(encoded, function flushed() { process.exit(exitCode); });
}
function computeReaderBuild(sources) {
  var crypto = require('node:crypto');
  var records = Object.keys(sources).sort().map(function record(name) {
    var bytes = Buffer.from(sources[name], 'utf8');
    return [name, bytes.length, bytes.toString('base64')];
  });
  // Spec §2.3: these arrays contain only strings and integers; JSON is canonical.
  return crypto.createHash('sha256').update(JSON.stringify(['palantir.snapshot-bundle/1'].concat(records)))
    .digest('hex').slice(0, 16);
}
function validRequest(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype) return false;
  if (value.op === 'answer_query') {
    var answerKeys = ['schema', 'op', 'now', 'target'];
    if (Object.prototype.hasOwnProperty.call(value, 'diag')) answerKeys.push('diag');
    var target = value.target;
    return Object.keys(value).length === answerKeys.length && answerKeys.every(function present(key) {
      return Object.prototype.hasOwnProperty.call(value, key);
    }) && value.schema === 'palantir.answer-request/1'
      && typeof value.now === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value.now)
      && isFinite(Date.parse(value.now)) && new Date(value.now).toISOString() === value.now
      && (answerKeys.indexOf('diag') === -1 || typeof value.diag === 'boolean')
      && target && typeof target === 'object' && !Array.isArray(target)
      && Object.keys(target).length === 4 && target.kind === 'instruction'
      && ['kind', 'instrId', 'ref', 'file_fp'].every(function present(key) {
        return Object.prototype.hasOwnProperty.call(target, key);
      }) && typeof target.instrId === 'string'
      && /^(claude|codex):[A-Za-z0-9_-]{1,64}:[uin][A-Za-z0-9_-]{1,64}$/.test(target.instrId)
      && typeof target.ref === 'string' && /^[0-9a-f]{16}$/.test(target.ref)
      && typeof target.file_fp === 'string' && /^[0-9a-f]{16}$/.test(target.file_fp);
  }
  var keys = ['schema', 'op', 'now', 'include_exec', 'orca_bin'];
  if (value.op === 'exclude_query' || value.op === 'exclude_commit') keys.push('target');
  if (value.op === 'exclude_commit') keys.push('token');
  var hasLabel = Object.prototype.hasOwnProperty.call(value, 'machine_label');
  if (value.op === 'snapshot' && hasLabel) keys.push('machine_label');
  return Object.keys(value).length === keys.length && keys.every(function present(key) {
    return Object.prototype.hasOwnProperty.call(value, key);
  }) && value.schema === 'palantir.snapshot-request/1'
    && ['snapshot', 'exclude_query', 'exclude_commit'].indexOf(value.op) !== -1
    && typeof value.now === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value.now)
    && isFinite(Date.parse(value.now)) && new Date(value.now).toISOString() === value.now
    && (!hasLabel || typeof value.machine_label === 'string'
      && /^[A-Za-z0-9._-]{1,32}$/.test(value.machine_label) && value.machine_label.charAt(0) !== '-')
    && typeof value.include_exec === 'boolean' && (value.orca_bin === null || typeof value.orca_bin === 'string'
    && /^[A-Za-z0-9._/-]{1,512}$/.test(value.orca_bin) && value.orca_bin.charAt(0) !== '-')
    && (value.op !== 'exclude_commit' || typeof value.token === 'string' && /^[0-9a-f]{64}$/.test(value.token));
}
function launch() {
  var answerDeadlineAt = REQUEST.op === 'answer_query' ? Date.now() + 25000 : undefined;
  // Check major before compiling any other manifest source.
  if (Number(process.versions.node.split('.')[0]) < 18) {
    launcherBuild = computeReaderBuild(BUNDLE_SOURCES);
    launcherEmit(launcherStatus('node_unsupported'), 0);
    return;
  }
  launcherBuild = computeReaderBuild(BUNDLE_SOURCES);
  if (!validRequest(REQUEST)) {
    launcherEmit(launcherStatus('request_invalid'), 0);
    return;
  }
  var reader = require('./sessionSnapshotReader.cjs');
  var home = require('node:os').homedir();
  var options = { homeDir: home, configDir: require('node:path').join(home, '.config', 'palantir'),
    now: new Date(REQUEST.now), includeExec: REQUEST.include_exec, readerBuild: launcherBuild };
  if (REQUEST.orca_bin !== null && REQUEST.op !== 'answer_query') {
    options.runOrca = function runOrca(args) { return reader.defaultRunOrca(args, REQUEST.orca_bin); };
  }
  if (REQUEST.op === 'snapshot' && Object.prototype.hasOwnProperty.call(REQUEST, 'machine_label')) {
    options.machineLabel = REQUEST.machine_label;
  }
  if (REQUEST.op !== 'snapshot') options.target = REQUEST.target;
  if (REQUEST.op === 'exclude_commit') options.token = REQUEST.token;
  try {
    var result = REQUEST.op === 'answer_query' ? require('./sessionAnswerReader.cjs').readAnswer({
      homeDir: home, configDir: options.configDir, now: options.now, readerBuild: launcherBuild,
      instrId: REQUEST.target.instrId, ref: REQUEST.target.ref, file_fp: REQUEST.target.file_fp, diag: REQUEST.diag,
      deadlineAt: answerDeadlineAt
    }) : REQUEST.op === 'snapshot' ? reader.runSnapshot(options)
      : REQUEST.op === 'exclude_query' ? reader.excludeQuery(options) : reader.excludeCommit(options);
    setImmediate(function completed() { launcherEmit(result, 0); });
  } catch (error) {
    if (error instanceof reader.ReaderError) launcherEmit(launcherStatus(error.code), 0);
    else throw error;
  }
}
module.exports = { computeReaderBuild: computeReaderBuild };
if (typeof REQUEST !== 'undefined') launch();
