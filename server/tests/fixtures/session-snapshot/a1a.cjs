'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { fixture, NOW } = require('./helpers.cjs');
const TS = '2026-10-08T02:00:00.000Z';
const user = (text, extra = {}) => ({ type: 'user', sessionId: 's', uuid: 'u', parentUuid: null,
  timestamp: TS, cwd: '/synthetic/repo', message: { content: text }, origin: { kind: 'human' }, ...extra });
const meta = (extra = {}) => ({ type: 'session_meta', timestamp: TS,
  payload: { id: 's', cwd: '/synthetic/repo', source: 'cli', thread_source: 'user', ...extra } });
const message = (extra = {}) => ({ type: 'response_item', timestamp: TS,
  payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Synthetic instruction A' }], ...extra } });
const cases = {
  claude: [['claude', 's', [user('Synthetic instruction A'),
    { type: 'assistant', sessionId: 's', uuid: 'a', parentUuid: 'u', timestamp: TS,
      message: { stop_reason: 'end_turn', content: [{ type: 'text', text: 'ANSWER_BODY_SENTINEL' }] } }]]],
  queued_resume: [['claude', 's', [user('Synthetic instruction A'),
    { type: 'attachment', sessionId: 's', uuid: 'q', timestamp: TS,
      attachment: { type: 'queued_command', origin: { kind: 'human' }, commandMode: 'prompt',
        prompt: 'Queued instruction', humanTurn: true } },
    { type: 'assistant', sessionId: 's', uuid: 'a', parentUuid: 'u', timestamp: TS,
      message: { stop_reason: 'end_turn' } },
    { type: 'assistant', sessionId: 's', uuid: 'b', parentUuid: 'a', timestamp: TS,
      message: { stop_reason: 'tool_use' } }]]],
  codex: [['codex', 's', [meta(), { type: 'event_msg', timestamp: TS,
    payload: { type: 'task_started', turn_id: 't' } }, message(),
    { type: 'event_msg', timestamp: TS, payload: { type: 'task_complete', turn_id: 't',
      last_agent_message: 'ANSWER_BODY_SENTINEL' } }]]],
  held: [['claude', 's', [user('Synthetic instruction A'), user('Duplicate')]],
    ['codex', 's', [meta({ source: 'exec' }), message()]]]
};
function setup(t, transcripts = cases.claude) {
  const f = fixture(t);
  const key = 'a'.repeat(64);
  fs.mkdirSync(path.dirname(f.config), { recursive: true });
  fs.writeFileSync(f.config, JSON.stringify({ machine_id: 'm', machine_label: 'fixture', path_salt: 'fixture-salt',
    path_gen: 1, local_key: key, key_fingerprint: crypto.createHash('sha256').update(key).digest('hex'),
    exclude: { sessions: [], instructions: [] } }));
  // The existing bundle fixture supplies the first Claude file; overwrite it for these cases.
  fs.writeFileSync(path.join(f.home, '.claude/projects/s.jsonl'), '');
  const files = [];
  for (const [provider, name, records] of transcripts) {
    const filename = path.join(f.home, provider === 'claude' ? '.claude/projects' : '.codex/sessions', name + '.jsonl');
    fs.mkdirSync(path.dirname(filename), { recursive: true });
    fs.writeFileSync(filename, records.map(record => JSON.stringify(record)).join('\n') + '\n');
    files.push(filename);
  }
  return { ...f, files, options: { homeDir: f.home, configDir: path.dirname(f.config), now: new Date(NOW),
    readerBuild: '0123456789abcdef', runOrca: () => null } };
}
module.exports = { setup, cases, user, meta, message, TS };
