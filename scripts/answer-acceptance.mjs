import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { performance } from 'node:perf_hooks';
const require = createRequire(import.meta.url);
const policy = require('../server/services/observeSnapshotPolicy.js');
const CLI = fileURLToPath(new URL('./session-snapshot.mjs', import.meta.url));
const AUDIT = fileURLToPath(new URL('./answer-audit.mjs', import.meta.url));
const FEATURE_NAMES = Object.freeze(['queued', 'end_turn_resumed', 'interrupted']);
const AUDIT_CHECK_NAMES = new Set(['input', 'file_unique', 'stable_file', 'session_identity', 'instruction',
  'queued_has_no_own_execution', 'no_resume', 'chain_and_branches',
  'segment_end', 'nonterminal_segment', 'evidence_in_segment', 'terminal_evidence', 'same_message_group',
  'instruction_in_segment', 'turn_id', 'closed_without_conflict', 'audit_complete', 'execution',
  'claim_status', 'supported_format', 'unbound_reason', 'unbound_diag']);
function receiveAudit(value, inspect = false) {
  const exact = (o, keys) => o && typeof o === 'object' && !Array.isArray(o)
    && Object.keys(o).length === keys.length && keys.every(k => Object.hasOwn(o, k));
  if (!exact(value, inspect ? ['ok', 'checks', 'features'] : ['ok', 'checks']) || typeof value.ok !== 'boolean' || !Array.isArray(value.checks)
    || !value.checks.length || value.checks.length > 64 || value.checks.some(c => !exact(c, ['name', 'ok'])
      || typeof c.name !== 'string' || !AUDIT_CHECK_NAMES.has(c.name) || typeof c.ok !== 'boolean')
    || new Set(value.checks.map(c => c.name)).size !== value.checks.length
    || value.ok !== value.checks.every(c => c.ok)
    || inspect && (!exact(value.features, FEATURE_NAMES) || FEATURE_NAMES.some(name => typeof value.features[name] !== 'boolean'))) return null;
  return { ok: value.ok, checks: value.checks.map(c => ({ name: c.name, ok: c.ok })),
    ...(inspect ? { features: Object.fromEntries(FEATURE_NAMES.map(name => [name, value.features[name]])) } : {}) };
}
function targetsFrom(raw) {
  const values = JSON.parse(raw || '[]'), names = new Set(), ids = new Set();
  if (!Array.isArray(values)) throw Error('request_invalid');
  const label = /^[A-Za-z0-9._][A-Za-z0-9._-]{0,31}$/, absolute = /^\/[A-Za-z0-9._/-]+$/;
  return values.map(value => {
    if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).some(k => !['name', 'kind', 'host', 'machineId', 'label', 'remoteNode', 'orcaBin'].includes(k))
      || typeof value.name !== 'string' || !label.test(value.name) || !policy.isSafeId(value.machineId)
      || !['local', 'ssh'].includes(value.kind) || names.has(value.name) || ids.has(value.machineId)
      || value.kind === 'ssh' && (typeof value.host !== 'string' || !/^[A-Za-z0-9._][A-Za-z0-9._-]*(?:@[A-Za-z0-9._-]+)?$/.test(value.host))
      || value.kind === 'local' && (value.host !== undefined || value.remoteNode !== undefined)
      || value.label !== undefined && (typeof value.label !== 'string' || !label.test(value.label))
      || ['remoteNode', 'orcaBin'].some(k => value[k] !== undefined && (typeof value[k] !== 'string' || !absolute.test(value[k])))) throw Error('request_invalid');
    names.add(value.name); ids.add(value.machineId); return Object.freeze({ ...value });
  });
}
export function selectSamples(snapshots) {
  const samples = [];
  for (const snapshot of snapshots) for (const provider of ['claude', 'codex']) {
    const sessions = snapshot.sessions.filter(s => s.provider === provider).sort((a, b) =>
      b.last_record_at.localeCompare(a.last_record_at) || a.key.localeCompare(b.key));
    const instructions = session => snapshot.instructions.filter(i => i.session_key === session.key).sort((a, b) => a.seq - b.seq);
    const add = (group, session, instruction, subtype) => {
      if (instruction) samples.push(Object.freeze({ group, ...(subtype ? { subtype } : {}), machine_id: snapshot.machine.id,
        provider, key: session.key, instrId: instruction.id, ref: instruction.ref, file_fp: session.file_fp ?? null,
        cli_version: session.cli_version }));
    };
    for (const session of sessions.filter(s => s.status?.source === 'transcript' && s.status.state === 'ended').slice(0, 10)) add('A', session, instructions(session).at(-1));
    for (const session of sessions.filter(s => s.instruction_total >= 5).slice(0, 5)) add('B', session, instructions(session).at(-3));
    // C requires query-time classification, including historical interruptions.
  }
  return Object.freeze(samples);
}
function run(command, args, { env, input, timeoutMs = 35000 } = {}) {
  return new Promise(resolve => {
    const started = performance.now(); let output = '', bytes = 0, failed = false;
    const child = spawn(command, args, { shell: false, env, stdio: ['pipe', 'pipe', 'ignore'] });
    const timer = setTimeout(() => { failed = true; child.kill('SIGKILL'); }, timeoutMs);
    child.stdout.on('data', chunk => { bytes += chunk.length; if (bytes > 64 * 1024) { failed = true; child.kill('SIGKILL'); } else output += chunk.toString(); });
    child.on('error', () => { failed = true; });
    child.on('close', code => { clearTimeout(timer); let value; try { value = JSON.parse(output); } catch { failed = true; }
      resolve({ value: code === 0 && !failed ? value : null, elapsed_ms: performance.now() - started }); });
    child.stdin.on('error', () => {}); child.stdin.end(input);
  });
}
const cliArgs = (target, sample, now) => [CLI, ...(target.kind === 'ssh' ? ['remote', '--host', target.host,
  ...(target.remoteNode ? ['--remote-node', target.remoteNode] : [])] : []), 'answer', '--instruction', sample.instrId + '#' + sample.ref,
  '--file-fp', sample.file_fp, '--diag', ...(now ? ['--now', now] : [])];
async function auditRun(execute, target, input, env, source, inspect = false) {
  const auditArgs = ['--provider', input.provider, '--instr-id', input.instrId, '--file-fp', input.file_fp,
    '--evidence-ids', JSON.stringify(input.evidence_ids), '--segment', JSON.stringify(input.segment),
    ...(input.expected_status ? ['--status', input.expected_status] : []),
    ...(input.expected_reason ? ['--reason', input.expected_reason] : []), ...(inspect ? ['--inspect'] : [])];
  return target.kind === 'ssh' ? execute(env.PALANTIR_OBSERVE_SSH_BIN || 'ssh',
    ['-o', 'BatchMode=yes', '--', target.host, target.remoteNode || 'node', '-', ...auditArgs.map(shellQuote)], { env, input: source })
    : execute(process.execPath, [AUDIT], { env: { ...env, ANSWER_AUDIT_INPUT: JSON.stringify({ ...input, inspect }) } });
}
export async function main(argv, { env = process.env, stdout = process.stdout, execute = run } = {}) {
  const options = {};
  for (let i = 0; i < argv.length; i += 2) {
    if (!['--snapshot-dir', '--targets', '--out', '--latency-repeat', '--now'].includes(argv[i]) || argv[i + 1] === undefined || options[argv[i]] !== undefined) throw Error('request_invalid');
    options[argv[i]] = argv[i + 1];
  }
  if (!options['--snapshot-dir'] || !options['--out']) throw Error('request_invalid');
  const targets = targetsFrom(options['--targets'] ?? env.PALANTIR_SNAPSHOT_TARGETS);
  const repeat = options['--latency-repeat'] === undefined ? 10 : Number(options['--latency-repeat']);
  if (!Number.isSafeInteger(repeat) || repeat < 1 || repeat > 100) throw Error('request_invalid');
  const snapshots = fs.readdirSync(options['--snapshot-dir']).filter(name => name.endsWith('.json')).sort().map(name => {
    const file = path.join(options['--snapshot-dir'], name); if (fs.statSync(file).size > 16 * 1024 * 1024) throw Error('snapshot_invalid');
    const snapshot = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!policy.validateSnapshot(snapshot).ok) throw Error('snapshot_invalid'); return snapshot;
  });
  const initial = [...selectSamples(snapshots)];
  const candidates = [];
  const auditSource = fs.readFileSync(AUDIT, 'utf8');
  const discoveryFailures = [], specialDiscovery = [];
  for (const snapshot of snapshots) for (const provider of ['claude', 'codex']) {
    const sessions = snapshot.sessions.filter(s => s.provider === provider).sort((a, b) => b.last_record_at.localeCompare(a.last_record_at) || a.key.localeCompare(b.key));
    if (!sessions.length) continue;
    const found = new Map(), applicable = provider === 'claude' ? FEATURE_NAMES : ['interrupted'];
    const target = targets.find(t => t.machineId === snapshot.machine.id);
    let failed = false;
    for (const session of sessions) {
      if (applicable.every(name => found.has(name))) break;
      const instructions = snapshot.instructions.filter(i => i.session_key === session.key).sort((a, b) => b.seq - a.seq || a.id.localeCompare(b.id));
      if (!instructions.length) continue;
      if (!target || !session.file_fp) {
        failed = true;
        discoveryFailures.push({ machine_id: snapshot.machine.id, provider, key: session.key,
          instrId: instructions[0].id, reason: !target ? 'target_missing' : 'file_missing' });
        continue;
      }
      for (const instruction of instructions) {
        if (applicable.every(name => found.has(name))) break;
        const sample = { group: 'C', machine_id: snapshot.machine.id, provider, key: session.key,
          instrId: instruction.id, ref: instruction.ref, file_fp: session.file_fp, cli_version: session.cli_version };
        const response = await auditRun(execute, target, { provider, instrId: sample.instrId, file_fp: sample.file_fp,
          evidence_ids: [], segment: { start_id: null, end_id: null } }, env, auditSource, true);
        const discovery = receiveAudit(response.value, true);
        if (!discovery?.ok) {
          failed = true; discoveryFailures.push({ machine_id: sample.machine_id, provider, key: sample.key, instrId: sample.instrId,
            reason: discovery ? 'audit_failed' : 'audit_invalid' }); continue;
        }
        for (const name of applicable) if (!found.has(name) && discovery.features[name]) found.set(name, sample);
      }
    }
    for (const feature of FEATURE_NAMES) {
      const sample = found.get(feature);
      if (sample) candidates.push({ ...sample, subtype: feature === 'end_turn_resumed' ? 'resumed' : feature });
      specialDiscovery.push({ machine_id: snapshot.machine.id, provider, feature,
        status: sample ? 'found' : failed && applicable.includes(feature) ? 'unknown' : 'absent',
        key: sample?.key ?? null, instrId: sample?.instrId ?? null });
    }
  }
  const samples = Object.freeze([...initial, ...candidates].map(Object.freeze));
  stdout.write(JSON.stringify({ samples, special_discovery: specialDiscovery }) + '\n');
  const measurements = [];
  for (const sample of samples) {
    const target = targets.find(t => t.machineId === sample.machine_id);
    const times = []; let answer = null, audit = null, auditInvalid = false, auditElapsedMs = null;
    for (let i = 0; i < repeat; i++) {
      if (!target || !sample.file_fp) { answer = { status: 'target_changed', reason: 'file_missing' }; times.push(0); continue; }
      const response = await execute(process.execPath, cliArgs(target, sample, options['--now']), { env });
      times.push(response.elapsed_ms); if (i === 0) answer = response.value ?? { status: 'unavailable', reason: 'exec_failed' };
    }
    if (target && sample.file_fp) {
      const input = { provider: sample.provider, instrId: sample.instrId, file_fp: sample.file_fp,
        evidence_ids: answer.diag?.evidence_ids ?? [], segment: answer.diag?.segment ?? { start_id: null, end_id: null },
        expected_status: answer.status, expected_reason: answer.reason };
      const result = await auditRun(execute, target, input, env, auditSource);
      audit = receiveAudit(result.value);
      auditInvalid = audit === null;
      if (auditInvalid) audit = { ok: false, checks: [{ name: 'audit_invalid', ok: false }] };
      auditElapsedMs = Number.isFinite(result.elapsed_ms) && result.elapsed_ms >= 0 ? result.elapsed_ms : null;
    }
    if (!audit) audit = { ok: false, checks: [{ name: 'audit_unavailable', ok: false }] };
    measurements.push({ sample, status: answer.status, reason: answer.reason, audit, audit_invalid: auditInvalid,
      latency_ms: times, audit_elapsed_ms: auditElapsedMs, independent_file_find_ms: null });
  }
  const groups = [];
  for (const machine_id of [...new Set(samples.map(s => s.machine_id))]) for (const provider of ['claude', 'codex']) {
    const rows = measurements.filter(m => m.sample.machine_id === machine_id && m.sample.provider === provider);
    if (!rows.length) continue;
    const a = rows.filter(m => m.sample.group === 'A'); const covered = a.filter(m => ['final', 'no_text'].includes(m.status)).length;
    const times = rows.flatMap(m => m.latency_ms).sort((x, y) => x - y);
    const median = times.length % 2 ? times[(times.length - 1) / 2] : (times[times.length / 2 - 1] + times[times.length / 2]) / 2;
    const distribution = {}; for (const row of rows) { const key = row.status + '/' + (row.reason ?? '-'); distribution[key] = (distribution[key] ?? 0) + 1; }
    groups.push({ machine_id, provider, cli_versions: [...new Set(rows.map(r => r.sample.cli_version))], distribution,
      a_total: a.length, a_covered: covered, a_coverage: a.length ? covered / a.length : null,
      audit_mismatches: rows.filter(r => r.audit.ok === false).length,
      audit_invalid: rows.filter(r => r.audit_invalid).length, median_ms: median, max_ms: times.at(-1) });
  }
  const machineAccepted = discoveryFailures.length === 0 && groups.length > 0 && groups.every(g => g.audit_mismatches === 0 && g.a_coverage !== null && g.a_coverage >= 0.8
    && g.median_ms <= (targets.find(t => t.machineId === g.machine_id)?.kind === 'local' ? 3000 : 5000)
    && g.max_ms <= (targets.find(t => t.machineId === g.machine_id)?.kind === 'local' ? 6000 : 10000));
  const report = { samples, measurements, groups, machine_checks_passed: machineAccepted, accepted: false,
    discovery_failures: discoveryFailures, special_discovery: specialDiscovery, latency_scope: 'cli_machine_path', file_find_scope: 'not_collected_closed_audit',
    follow_ups: ['A2 화면 endpoint 지연 및 사람 원본 대조 필요'] };
  stdout.write('machine/provider\tstatus/reason\tA coverage\taudit mismatches\taudit invalid\tmedian/max ms\n');
  for (const group of groups) stdout.write(`${group.machine_id}/${group.provider}\t${JSON.stringify(group.distribution)}\t${group.a_covered}/${group.a_total}\t${group.audit_mismatches}\t${group.audit_invalid}\t${group.median_ms}/${group.max_ms}\n`);
  fs.mkdirSync(path.dirname(path.resolve(options['--out'])), { recursive: true, mode: 0o700 });
  fs.writeFileSync(options['--out'], JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  return report;
}
function shellQuote(value) { return "'" + value.replaceAll("'", "'\\''") + "'"; }
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch(() => { process.stderr.write('request_invalid\nhint: --snapshot-dir --targets JSON --out [--latency-repeat 10]\n'); process.exitCode = 2; });
}
