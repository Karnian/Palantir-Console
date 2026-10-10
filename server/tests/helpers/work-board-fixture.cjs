'use strict';

const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { runSnapshot, loadConfig } = require('../../../scripts/lib/sessionSnapshotReader.cjs');
const { validateSnapshot } = require('../../services/observeSnapshotPolicy');

const NOW = '2026-10-10T03:00:00.000Z';
const TOKEN = 'observe-ui-synthetic-token';

function createSnapshots(root) {
  const homeDir = path.join(root, 'home');
  const projects = path.join(homeDir, '.claude', 'projects');
  fs.mkdirSync(projects, { recursive: true });
  const prompts = [
    ['인증 흐름을 검토해 주세요.',
      '로그인 리다이렉트 테스트를 추가해 주세요.\n쿠키 만료도 확인해 주세요.'],
    ['이미지 크기별 결과를 정리해 주세요.', '큰 파일만 표로 정리해 주세요.'],
    ['주간 보고 초안을 작성해 주세요.', '이번 주 변경 내용을 요약해 주세요.'],
  ];
  prompts.forEach((texts, index) => {
    const records = texts.map((text, seq) => ({
      type: 'user', sessionId: `session-${index}`, uuid: `user-${index}-${seq}`,
      parentUuid: seq ? `user-${index}-0` : null,
      timestamp: `2026-10-10T02:${index}${seq}:00.000Z`,
      cwd: path.join(root, ['console', 'image-tools', 'weekly-report'][index]), gitBranch: 'main',
      origin: { kind: 'human' }, message: { content: text },
    }));
    records.push({ type: 'ai-title', sessionId: `session-${index}`, title: '합성 세션 검토',
      timestamp: '2026-10-10T02:30:00.000Z' });
    fs.writeFileSync(path.join(projects, `session-${index}.jsonl`), records.map(JSON.stringify).join('\n'));
  });
  const options = { homeDir, configDir: path.join(homeDir, '.config', 'palantir'),
    now: new Date(NOW), readerBuild: '0123456789abcdef', runOrca: () => null };
  const config = loadConfig(options);
  config.machine_id = 'alpha'; config.machine_label = 'Mac';
  fs.writeFileSync(path.join(options.configDir, 'observe.json'), JSON.stringify(config));
  const base = runSnapshot(options);
  assert.equal(validateSnapshot(base).ok, true);
  assert.equal(base.sessions.length, 3);
  assert.equal(base.instructions.length, 6);
  const alpha = structuredClone(base);
  alpha.sessions = alpha.sessions.slice(0, 2);
  alpha.instructions = alpha.instructions.filter(row =>
    alpha.sessions.some(session => session.key === row.session_key));
  alpha.sessions[1].first_instruction = 'unrecoverable';
  alpha.sessions[1].compact_only_history = true;
  alpha.instructions[1].redacted = true;
  alpha.instructions[1].truncated = true;
  alpha.instructions[1].attachments = 2;
  alpha.coverage.orca = { state: 'ok', code: null };
  const session = alpha.sessions[0];
  session.orca_link = { evidence: 'prompt_exact', confirmed: true, pane_key: 'pane-1', terminal_handle: 'term-1' };
  alpha.orca.worktrees = [{ worktree_id: 'tree-1', repo_label: 'console', path_id: session.cwd_id,
    branch: 'main', status: 'active', last_activity_at: session.last_record_at, live_terminals: 1,
    agents: [{ pane_key: 'pane-1', state: 'waiting', agent_type: 'claude',
      state_started_at: session.last_record_at, updated_at: session.last_record_at, interrupted: false }] }];
  const beta = structuredClone(base);
  beta.machine = { id: 'beta', label: 'codev2' };
  beta.generated_at = '2026-10-10T02:55:00.000Z';
  beta.sessions = beta.sessions.slice(2);
  const oldKey = beta.sessions[0].key;
  beta.sessions[0].key = 'beta:codex:session-2';
  beta.sessions[0].provider = 'codex';
  beta.sessions[0].first_instruction = 'unknown';
  beta.sessions[0].format_unverified = true;
  beta.sessions[0].unknown_count = 1;
  beta.instructions = beta.instructions.filter(row => row.session_key === oldKey).map((row, index) => ({
    ...row, session_key: beta.sessions[0].key, id: `codex:session-2:n${index + 1}`,
  }));
  beta.coverage.codex.exec_sessions_excluded = 4;
  beta.coverage.codex.withheld_sessions = 1;
  for (const snapshot of [alpha, beta]) assert.equal(validateSnapshot(snapshot).ok, true);
  return { alpha, beta, homeDir };
}

module.exports = { createSnapshots, NOW, TOKEN };
