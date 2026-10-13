'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const reader = require('../../scripts/lib/sessionSnapshotReader.cjs');
const { setup, user, TS } = require('./fixtures/session-snapshot/a1a.cjs');
test('acceptance fixes A/B/C samples before measurement, failures remain in A denominator, repeats include failures', async t => {
  const f = setup(t); const api = await import('../../scripts/answer-acceptance.mjs');
  const s = reader.runSnapshot(f.options);
  // Five synthetic instructions support the B sample; final instruction is the A sample.
  s.instructions = Array.from({ length: 5 }, (_, i) => ({ ...s.instructions[0], id: 'claude:s:uu' + i, seq: i + 1 }));
  s.sessions[0].instruction_count = 5; s.sessions[0].instruction_total = 5;
  s.sessions[0].status = { state: 'ended', source: 'transcript', evidence_at: TS, reason: null };
  fs.mkdirSync(f.out); fs.writeFileSync(path.join(f.out, 'm.json'), JSON.stringify(s));
  const out = path.join(f.root, 'results.json'); let printed = false, output = '', measured = 0;
  const report = await api.main(['--snapshot-dir', f.out, '--targets', JSON.stringify([{ name: 'fixture', kind: 'local', machineId: 'm' }]),
    '--out', out, '--latency-repeat', '2'], { env: f.env, stdout: { write(text) { output += text; if (text.startsWith('{"samples":')) printed = true; } },
    async execute(command, args, options) {
      if (args[0].endsWith('answer-audit.mjs') && JSON.parse(options.env.ANSWER_AUDIT_INPUT).inspect) {
        const input = JSON.parse(options.env.ANSWER_AUDIT_INPUT);
        return { elapsed_ms: 1, value: { ok: true, checks: [{ name: 'instruction', ok: true }],
          features: { queued: input.instrId.endsWith('uu3'), end_turn_resumed: input.instrId.endsWith('uu2'), interrupted: false } } };
      }
      if (args[0].endsWith('answer-audit.mjs')) return { elapsed_ms: 1, value: { ok: false, checks: [{ name: 'audit_complete', ok: false }] } };
      assert.equal(printed, true); measured++;
      return { elapsed_ms: measured * 100, value: { status: 'withheld', reason: 'held', text_chars: 0 } };
    } });
  assert.deepEqual(report.samples.map(x => [x.group, x.instrId, x.subtype ?? null]), [
    ['A', 'claude:s:uu4', null], ['B', 'claude:s:uu2', null], ['C', 'claude:s:uu3', 'queued'], ['C', 'claude:s:uu2', 'resumed']]);
  assert.equal(measured, 8); assert.equal(report.groups[0].a_total, 1); assert.equal(report.groups[0].a_coverage, 0);
  assert.equal(report.machine_checks_passed, false); assert.equal(report.accepted, false);
  assert.deepEqual(JSON.parse(fs.readFileSync(out)), report);
  assert.equal(output.includes('ANSWER_BODY_SENTINEL'), false);
  assert.equal(fs.statSync(out).mode & 0o777, 0o600);
});
test('A uses transcript ended and stable latest ordering; B uses third from last; C awaits classification', async () => {
  const { selectSamples } = await import('../../scripts/answer-acceptance.mjs');
  const sessions = Array.from({ length: 13 }, (_, i) => ({ key: 'k' + i, provider: 'codex', last_record_at: `2026-10-${String(i + 1).padStart(2, '0')}T00:00:00.000Z`,
    instruction_total: 5, file_fp: 'a'.repeat(16), status: { source: 'transcript', state: i === 12 ? 'interrupted' : 'ended' } }));
  const instructions = sessions.flatMap(s => Array.from({ length: 5 }, (_, i) => ({ session_key: s.key, seq: i + 1, id: 'codex:' + s.key + ':n' + (i + 1), ref: 'b'.repeat(16) })));
  const samples = selectSamples([{ machine: { id: 'm' }, sessions, instructions }]);
  assert.equal(samples.filter(s => s.group === 'A').length, 10);
  assert.equal(samples.filter(s => s.group === 'B').length, 5);
  assert.ok(samples.filter(s => s.group === 'A').every(s => s.instrId.endsWith(':n5')));
  assert.ok(samples.filter(s => s.group === 'B').every(s => s.instrId.endsWith(':n3')));
  assert.equal(samples.filter(s => s.group === 'C').length, 0);
  assert.equal(Object.isFrozen(samples), true);
});
for (const kind of ['local', 'ssh']) test(`acceptance ${kind} executes actual fixture CLI and independent audit`, async t => {
  const f = setup(t); const api = await import('../../scripts/answer-acceptance.mjs');
  const snapshot = reader.runSnapshot(f.options); fs.mkdirSync(f.out); fs.writeFileSync(path.join(f.out, 'm.json'), JSON.stringify(snapshot));
  const target = { name: 'fixture', kind, machineId: 'm', ...(kind === 'ssh' ? { host: 'synthetic@host', remoteNode: '/synthetic/node' } : {}) };
  const env = { ...f.env, PALANTIR_OBSERVE_SSH_BIN: path.resolve(__dirname, 'fixtures/bin/fake-answer-audit-ssh.cjs') };
  let output = '';
  const report = await api.main(['--snapshot-dir', f.out, '--targets', JSON.stringify([target]), '--out', path.join(f.root, 'report.json'),
    '--latency-repeat', '2', '--now', f.request.now], { env, stdout: { write(text) { output += text; } } });
  assert.equal(report.samples.length, 1); assert.equal(report.measurements[0].status, 'final');
  assert.equal(report.measurements[0].audit.ok, true); assert.equal(report.groups[0].audit_mismatches, 0);
  assert.equal(report.groups[0].a_coverage, 1); assert.equal(report.measurements[0].latency_ms.length, 2);
  assert.ok(Number.isFinite(report.measurements[0].audit_elapsed_ms));
  assert.equal(report.measurements[0].independent_file_find_ms, null);
  assert.equal(JSON.stringify(report).includes('ANSWER_BODY_SENTINEL'), false);
  assert.equal(output.includes('ANSWER_BODY_SENTINEL'), false);
});
for (const status of ['pending', 'queued_joined', 'local_command']) test(`R1 S2 acceptance audits ${status} in sample A`, async t => {
  const f = setup(t); const api = await import('../../scripts/answer-acceptance.mjs');
  const snapshot = reader.runSnapshot(f.options); fs.mkdirSync(f.out); fs.writeFileSync(path.join(f.out, 'm.json'), JSON.stringify(snapshot));
  let audited = 0;
  const report = await api.main(['--snapshot-dir', f.out, '--targets', JSON.stringify([{ name: 'fixture', kind: 'local', machineId: 'm' }]),
    '--out', path.join(f.root, 'results.json'), '--latency-repeat', '1'], { env: f.env, stdout: { write() {} },
    async execute(command, args, options) {
      if (args[0].endsWith('answer-audit.mjs')) {
        const input = JSON.parse(options.env.ANSWER_AUDIT_INPUT);
        if (input.inspect) return { elapsed_ms: 1, value: { ok: true, checks: [{ name: 'input', ok: true }],
          features: { queued: false, end_turn_resumed: false, interrupted: false } } };
        audited++; assert.equal(input.expected_status, status);
        return { elapsed_ms: 1, value: { ok: false, checks: [{ name: 'nonterminal_segment', ok: false }] } };
      }
      return { elapsed_ms: 1, value: { status, reason: null, diag: { evidence_ids: [], segment: { start_id: 'u', end_id: 'a' } } } };
    } });
  assert.equal(audited, 1); assert.equal(report.groups[0].audit_mismatches, 1); assert.equal(report.measurements[0].audit.ok, false);
});
for (const bad of [
  { ok: true, checks: [{ name: 'input', ok: true }], text: 'AUDIT_SECRET_SENTINEL' },
  { ok: true, checks: [{ name: 'input', ok: true, text: 'AUDIT_SECRET_SENTINEL' }] },
  { ok: 'true', checks: [{ name: 'input', ok: true }] },
  { ok: true, checks: [{ name: 'AUDIT_SECRET_SENTINEL', ok: true }] },
  { ok: true, checks: [{ name: 'input', ok: 'true' }] }
]) test('R1 S3 malformed audit is rejected and never persisted: ' + JSON.stringify(bad), async t => {
  const f = setup(t); const api = await import('../../scripts/answer-acceptance.mjs');
  const snapshot = reader.runSnapshot(f.options); fs.mkdirSync(f.out); fs.writeFileSync(path.join(f.out, 'm.json'), JSON.stringify(snapshot));
  const out = path.join(f.root, 'results.json'); let stdout = '';
  const report = await api.main(['--snapshot-dir', f.out, '--targets', JSON.stringify([{ name: 'fixture', kind: 'local', machineId: 'm' }]),
    '--out', out, '--latency-repeat', '1'], { env: f.env, stdout: { write(text) { stdout += text; } },
    async execute(command, args, options) {
      if (args[0].endsWith('answer-audit.mjs')) return { elapsed_ms: 1, value: JSON.parse(options.env.ANSWER_AUDIT_INPUT).inspect
        ? { ok: true, checks: [{ name: 'input', ok: true }], features: { queued: false, end_turn_resumed: false, interrupted: false } } : bad };
      return { elapsed_ms: 1, value: { status: 'final', reason: null, diag: { evidence_ids: ['a'], segment: { start_id: 'u', end_id: 'a' } } } };
    } });
  assert.equal(report.groups[0].audit_invalid, 1); assert.equal(report.groups[0].audit_mismatches, 1);
  assert.deepEqual(report.measurements[0].audit, { ok: false, checks: [{ name: 'audit_invalid', ok: false }] });
  assert.equal(fs.readFileSync(out, 'utf8').includes('AUDIT_SECRET_SENTINEL'), false);
  assert.equal(stdout.includes('AUDIT_SECRET_SENTINEL'), false);
});
test('R1 S2 actual independent audit rejects pending claim on completed sample A', async t => {
  const { spawnSync } = require('node:child_process');
  const f = setup(t); const api = await import('../../scripts/answer-acceptance.mjs');
  const snapshot = reader.runSnapshot(f.options); fs.mkdirSync(f.out); fs.writeFileSync(path.join(f.out, 'm.json'), JSON.stringify(snapshot));
  const report = await api.main(['--snapshot-dir', f.out, '--targets', JSON.stringify([{ name: 'fixture', kind: 'local', machineId: 'm' }]),
    '--out', path.join(f.root, 'results.json'), '--latency-repeat', '1'], { env: f.env, stdout: { write() {} },
    async execute(command, args, options) {
      if (args[0].endsWith('answer-audit.mjs')) {
        const result = spawnSync(command, args, { env: options.env, encoding: 'utf8' });
        assert.equal(result.stderr, ''); return { elapsed_ms: 1, value: JSON.parse(result.stdout) };
      }
      return { elapsed_ms: 1, value: { status: 'pending', reason: null, diag: { evidence_ids: [], segment: { start_id: 'u', end_id: 'a' } } } };
    } });
  assert.equal(report.groups[0].audit_mismatches, 1); assert.equal(report.groups[0].audit_invalid, 0);
  assert.equal(report.measurements[0].audit.checks.find(c => c.name === 'nonterminal_segment').ok, false);
});
for (const kind of ['local', 'ssh']) for (const provider of ['claude', 'codex']) test(`R2 acceptance ${kind} audits correct ${provider} unbound reason`, async t => {
  const { cases, meta, message } = require('./fixtures/session-snapshot/a1a.cjs');
  const f = setup(t, cases[provider]); const api = await import('../../scripts/answer-acceptance.mjs');
  // Freeze the ended snapshot before the transcript develops a conflicting execution.
  const snapshot = reader.runSnapshot(f.options);
  fs.mkdirSync(f.out); fs.writeFileSync(path.join(f.out, 'm.json'), JSON.stringify(snapshot));
  const event = (type, turn_id) => ({ type: 'event_msg', timestamp: TS, payload: { type, turn_id } });
  const records = provider === 'claude'
    ? require('./fixtures/session-snapshot/answer-parallel-tools.cjs').cases.find(c => c.name.startsWith('R1 B1')).records
    : [meta(), event('task_started', 'T1'), message(), event('task_started', 'T2'), message(), event('task_complete', 'T2')];
  fs.writeFileSync(f.files[0], records.map(JSON.stringify).join('\n') + '\n');
  const env = { ...f.env, PALANTIR_OBSERVE_SSH_BIN: path.resolve(__dirname, 'fixtures/bin/fake-answer-audit-ssh.cjs') };
  let output = '';
  const report = await api.main(['--snapshot-dir', f.out, '--targets', JSON.stringify([{ name: 'fixture', kind, machineId: 'm',
    ...(kind === 'ssh' ? { host: 'synthetic@host', remoteNode: '/synthetic/node' } : {}) }]),
    '--out', path.join(f.root, 'report.json'), '--now', f.request.now], { env, stdout: { write(text) { output += text; } } });
  assert.equal(report.measurements[0].status, 'unbound');
  assert.equal(report.measurements[0].reason, provider === 'claude' ? 'branch_conflict' : 'segment_conflict');
  assert.equal(report.measurements[0].audit.ok, true, JSON.stringify(report.measurements[0].audit));
  assert.equal(report.groups[0].audit_mismatches, 0); assert.equal(report.groups[0].audit_invalid, 0);
  assert.equal(output.includes('ANSWER_BODY_SENTINEL'), false);
});
for (const special of [false, true]) test(`classification discovery ignores absent features and selects latest C special=${special}`, async t => {
  const f = setup(t); const api = await import('../../scripts/answer-acceptance.mjs');
  const s = reader.runSnapshot(f.options);
  s.instructions = Array.from({ length: 7 }, (_, i) => ({ ...s.instructions[0], id: 'claude:s:uu' + (i + 1), seq: i + 1 }));
  s.sessions[0].instruction_count = 7; s.sessions[0].instruction_total = 7;
  fs.mkdirSync(f.out); fs.writeFileSync(path.join(f.out, 'm.json'), JSON.stringify(s));
  let output = '', inspections = 0;
  const report = await api.main(['--snapshot-dir', f.out, '--targets', JSON.stringify([{ name: 'fixture', kind: 'local', machineId: 'm' }]),
    '--out', path.join(f.root, 'report.json'), '--latency-repeat', '1'], { env: f.env, stdout: { write(text) { output += text; } },
    async execute(command, args, options) {
      if (args[0].endsWith('answer-audit.mjs')) {
        const input = JSON.parse(options.env.ANSWER_AUDIT_INPUT);
        if (input.inspect) { inspections++;
          return { elapsed_ms: 1, value: { ok: true, checks: [{ name: 'instruction', ok: true }],
            features: { queued: special && ['claude:s:uu4', 'claude:s:uu3'].includes(input.instrId),
              end_turn_resumed: special && ['claude:s:uu5', 'claude:s:uu3'].includes(input.instrId),
              interrupted: special && ['claude:s:uu6', 'claude:s:uu3'].includes(input.instrId) } } };
        }
        return { elapsed_ms: 1, value: { ok: true, checks: [{ name: 'evidence_in_segment', ok: true }] } };
      }
      assert.ok(output.startsWith('{"samples":'));
      return { elapsed_ms: 1, value: { status: 'final', reason: null, diag: { evidence_ids: ['a'], segment: { start_id: 'u', end_id: 'a' } } } };
    } });
  assert.deepEqual(report.discovery_failures, []); assert.equal(report.machine_checks_passed, true);
  const c = report.samples.filter(sample => sample.group === 'C');
  assert.deepEqual(c.map(sample => [sample.subtype, sample.instrId]), special
    ? [['queued', 'claude:s:uu4'], ['resumed', 'claude:s:uu5'], ['interrupted', 'claude:s:uu6']] : []);
  assert.deepEqual(report.special_discovery.map(item => [item.feature, item.status]),
    ['queued', 'end_turn_resumed', 'interrupted'].map(feature => [feature, special ? 'found' : 'absent']));
  assert.ok(inspections >= 4);
});
for (const provider of ['claude', 'codex']) for (const kind of ['local', 'ssh']) test(`classification discovery actual ${provider} ${kind} finds historical C in ended session`, async t => {
  const { meta, message } = require('./fixtures/session-snapshot/a1a.cjs');
  const assistant = (uuid, parentUuid, stop, content) => ({ type: 'assistant', sessionId: 's', uuid, parentUuid, timestamp: TS,
    message: { id: uuid + '-message', stop_reason: stop, content } });
  const final = (uuid, parent) => assistant(uuid, parent, 'end_turn', [{ type: 'text', text: 'ANSWER_BODY_SENTINEL' }]);
  const event = (type, turn_id) => ({ type: 'event_msg', timestamp: TS, payload: { type, turn_id } });
  const records = provider === 'claude' ? [user('Synthetic instruction A'), final('a', 'u'),
    assistant('b', 'a', 'tool_use', [{ type: 'tool_use', id: 'call', name: 'synthetic', input: {} }]),
    { type: 'attachment', sessionId: 's', uuid: 'queued', parentUuid: 'b', timestamp: TS,
      attachment: { type: 'queued_command', origin: { kind: 'human' }, commandMode: 'prompt', prompt: 'Queued', humanTurn: true } },
    user('', { uuid: 'result', parentUuid: 'b', message: { content: [{ type: 'tool_result', tool_use_id: 'call', content: 'PRIVATE_TOOL_RESULT' }] } }),
    final('c', 'result'), user('Next instruction', { uuid: 'next', parentUuid: 'c' }),
    user('[Request interrupted by user]', { uuid: 'interrupted', parentUuid: 'next' }),
    user('Last instruction', { uuid: 'last', parentUuid: 'interrupted' }), final('last-answer', 'last')]
    : [meta(), event('task_started', 'T0'), message(), event('turn_aborted', 'T0'),
      event('task_started', 'T1'), message(), event('task_complete', 'T1')];
  const f = setup(t, [[provider, 's', records]]); const api = await import('../../scripts/answer-acceptance.mjs');
  const snapshot = reader.runSnapshot(f.options); assert.equal(snapshot.sessions[0].status.state, 'ended');
  fs.mkdirSync(f.out); fs.writeFileSync(path.join(f.out, 'm.json'), JSON.stringify(snapshot));
  let output = '';
  const report = await api.main(['--snapshot-dir', f.out, '--targets', JSON.stringify([{ name: 'fixture', kind, machineId: 'm',
    ...(kind === 'ssh' ? { host: 'synthetic@host', remoteNode: '/synthetic/node' } : {}) }]),
    '--out', path.join(f.root, 'report.json'), '--latency-repeat', '1', '--now', f.request.now], {
    env: { ...f.env, PALANTIR_OBSERVE_SSH_BIN: path.resolve(__dirname, 'fixtures/bin/fake-answer-audit-ssh.cjs') },
    stdout: { write(text) { output += text; } } });
  assert.deepEqual(report.samples.filter(sample => sample.group === 'C').map(sample => [sample.subtype, sample.instrId]),
    provider === 'claude' ? [['queued', 'claude:s:uqueued'], ['resumed', 'claude:s:uu'], ['interrupted', 'claude:s:unext']]
      : [['interrupted', 'codex:s:n1']]);
  assert.deepEqual(report.discovery_failures, []);
  assert.equal(report.groups[0].audit_mismatches, 0, JSON.stringify(report.measurements));
  assert.equal(report.machine_checks_passed, true);
  assert.equal(output.includes('ANSWER_BODY_SENTINEL'), false); assert.equal(output.includes('PRIVATE_TOOL_RESULT'), false);
});
for (const bad of [
  { ok: true, checks: [{ name: 'instruction', ok: true }], features: { queued: false, end_turn_resumed: false } },
  { ok: true, checks: [{ name: 'instruction', ok: true }], features: { queued: 'true', end_turn_resumed: false, interrupted: false } },
  { ok: true, checks: [{ name: 'instruction', ok: true }], features: { queued: true, end_turn_resumed: false, interrupted: false, text: 'CLASSIFIER_SECRET' } },
  { ok: true, checks: [{ name: 'queued', ok: true }], features: { queued: true, end_turn_resumed: false, interrupted: false } },
  { ok: true, checks: [{ name: 'instruction', ok: true }], features: { queued: true, end_turn_resumed: false, interrupted: false }, text: 'CLASSIFIER_SECRET' }
]) test('classification discovery rejects malformed closed feature schema: ' + JSON.stringify(bad), async t => {
  const f = setup(t); const api = await import('../../scripts/answer-acceptance.mjs');
  const snapshot = reader.runSnapshot(f.options); fs.mkdirSync(f.out); fs.writeFileSync(path.join(f.out, 'm.json'), JSON.stringify(snapshot));
  const out = path.join(f.root, 'report.json'); let output = '';
  const report = await api.main(['--snapshot-dir', f.out, '--targets', JSON.stringify([{ name: 'fixture', kind: 'local', machineId: 'm' }]),
    '--out', out, '--latency-repeat', '1'], { env: f.env, stdout: { write(text) { output += text; } },
    async execute(command, args, options) {
      if (args[0].endsWith('answer-audit.mjs')) return { elapsed_ms: 1,
        value: JSON.parse(options.env.ANSWER_AUDIT_INPUT).inspect ? bad : { ok: true, checks: [{ name: 'input', ok: true }] } };
      return { elapsed_ms: 1, value: { status: 'final', reason: null, diag: { evidence_ids: ['a'], segment: { start_id: 'u', end_id: 'a' } } } };
    } });
  assert.equal(report.discovery_failures.length, 1); assert.equal(report.discovery_failures[0].reason, 'audit_invalid');
  assert.equal(report.samples.filter(sample => sample.group === 'C').length, 0);
  assert.ok(report.special_discovery.every(item => item.status === 'unknown'));
  assert.equal(report.machine_checks_passed, false);
  assert.equal(fs.readFileSync(out, 'utf8').includes('CLASSIFIER_SECRET'), false); assert.equal(output.includes('CLASSIFIER_SECRET'), false);
});
for (const kind of ['local', 'ssh']) for (const shell of [false, true]) test(`send-now acceptance ${kind} shell=${shell} measures the interrupted C instruction independently of its successor`, async t => {
  const records = require('./fixtures/session-snapshot/answer-send-now.cjs').records({ followingAnswer: true, shell });
  const f = setup(t, [['claude', 's', records]]); const api = await import('../../scripts/answer-acceptance.mjs');
  const snapshot = reader.runSnapshot(f.options); fs.mkdirSync(f.out); fs.writeFileSync(path.join(f.out, 'm.json'), JSON.stringify(snapshot));
  let output = '';
  const report = await api.main(['--snapshot-dir', f.out, '--targets', JSON.stringify([{ name: 'fixture', kind, machineId: 'm',
    ...(kind === 'ssh' ? { host: 'synthetic@host', remoteNode: '/synthetic/node' } : {}) }]),
    '--out', path.join(f.root, 'report.json'), '--latency-repeat', '10', '--now', f.request.now], {
    env: { ...f.env, PALANTIR_OBSERVE_SSH_BIN: path.resolve(__dirname, 'fixtures/bin/fake-answer-audit-ssh.cjs') },
    stdout: { write(text) { output += text; } } });
  assert.deepEqual(report.samples.map(sample => [sample.group, sample.subtype ?? null, sample.instrId]),
    [['A', null, 'claude:s:u242'], ['C', 'interrupted', 'claude:s:u234']]);
  assert.deepEqual(report.measurements.map(row => row.status), ['final', 'interrupted']);
  assert.ok(report.measurements.every(row => row.latency_ms.length === 10 && row.audit.ok));
  assert.deepEqual(report.discovery_failures, []); assert.equal(report.groups[0].audit_mismatches, 0);
  assert.equal(report.machine_checks_passed, true);
  assert.equal(output.includes('ANSWER_BODY_SENTINEL'), false); assert.equal(output.includes('PRIVATE_'), false);
});
