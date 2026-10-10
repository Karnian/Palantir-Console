'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');
const { createSnapshots, TOKEN } = require('./work-board-fixture.cjs');

// Spec §7: synthetic HOME -> PR1 reader -> validated snapshots, isolated cookie server.
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'palantir-observe-ui-')));
const snapshotDir = path.join(root, 'snapshots');
fs.mkdirSync(snapshotDir, { mode: 0o700 });
const { alpha, beta, homeDir } = createSnapshots(root);
for (const snapshot of [alpha, beta]) {
  fs.writeFileSync(path.join(snapshotDir, `${snapshot.machine.id}.json`), JSON.stringify(snapshot), { mode: 0o600 });
}
const env = { ...process.env, HOME: homeDir, CODEX_HOME: path.join(homeDir, '.codex'),
  OPENCODE_STORAGE: path.join(root, 'opencode'), PALANTIR_DB: path.join(root, 'test.db'),
  PALANTIR_TOKEN: TOKEN, PALANTIR_OBSERVE_SNAPSHOT_DIR: snapshotDir, PORT: '4191', HOST: '127.0.0.1',
  PALANTIR_SKIP_DOTENV: '1', PALANTIR_SKIP_HOST_CREDENTIALS: '1',
  PALANTIR_MEMORY_DISTILL: '', PALANTIR_OPERATOR_SPECIALIST: '', PALANTIR_WEBHOOK_URL: '',
  PALANTIR_CODEX_FAST: '', PALANTIR_ACTOR_TOKEN_FILE: '', PALANTIR_PM_TOKEN: '', PALANTIR_WORKER_TOKEN: '',
  ANTHROPIC_API_KEY: '', ANTHROPIC_BASE_URL: '', CLAUDE_CODE_OAUTH_TOKEN: '', CODEX_API_KEY: '',
  OPENAI_API_KEY: '', GEMINI_API_KEY: '' };
const child = spawn(process.execPath, [path.resolve(__dirname, '../../index.js')], {
  cwd: root, env, stdio: 'inherit',
});
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
child.on('exit', code => {
  fs.rmSync(root, { recursive: true, force: true });
  process.exit(code || 0);
});
child.on('error', error => { console.error(error); process.exit(1); });
