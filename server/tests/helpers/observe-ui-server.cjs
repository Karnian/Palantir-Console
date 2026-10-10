'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');
const { createSnapshots, TOKEN } = require('./work-board-fixture.cjs');

// Spec §7: synthetic HOME -> PR1 reader -> validated snapshots, isolated cookie server.
function createObserveEnvironment(root, inherited = process.env) {
  const snapshotDir = path.join(root, 'snapshots');
  fs.mkdirSync(snapshotDir, { mode: 0o700 });
  const { alpha, beta, homeDir } = createSnapshots(root);
  for (const snapshot of [alpha, beta]) {
    const file = path.join(snapshotDir, `${snapshot.machine.id}.json`);
    fs.writeFileSync(file, JSON.stringify(snapshot), { mode: 0o600 });
  }
  const privateDir = name => {
    const directory = fs.mkdtempSync(path.join(root, `${name}-`));
    fs.chmodSync(directory, 0o700);
    return directory;
  };
  const codexHome = path.join(homeDir, '.codex');
  fs.mkdirSync(codexHome, { recursive: true, mode: 0o700 });
  fs.chmodSync(homeDir, 0o700);
  fs.chmodSync(codexHome, 0o700);
  return { ...inherited, HOME: homeDir, CODEX_HOME: codexHome,
    OPENCODE_STORAGE: privateDir('opencode'), PALANTIR_DB: path.join(root, 'test.db'),
    TMPDIR: privateDir('tmp'), TMUX_TMPDIR: privateDir('tmux'), TMUX: '', TMUX_PANE: '',
    // No engine override exists; an empty PATH makes detectTmux select subprocess.
    PATH: privateDir('bin'),
    PALANTIR_TOKEN: TOKEN, PALANTIR_OBSERVE_SNAPSHOT_DIR: snapshotDir, PORT: '4191', HOST: '127.0.0.1',
    PALANTIR_SKIP_DOTENV: '1', PALANTIR_SKIP_HOST_CREDENTIALS: '1',
    PALANTIR_MEMORY_DISTILL: '', PALANTIR_OPERATOR_SPECIALIST: '', PALANTIR_WEBHOOK_URL: '',
    PALANTIR_CODEX_FAST: '', PALANTIR_ACTOR_TOKEN_FILE: '', PALANTIR_PM_TOKEN: '', PALANTIR_WORKER_TOKEN: '',
    ANTHROPIC_API_KEY: '', ANTHROPIC_BASE_URL: '', CLAUDE_CODE_OAUTH_TOKEN: '', CODEX_API_KEY: '',
    OPENAI_API_KEY: '', GEMINI_API_KEY: '' };
}

function startServer() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'palantir-observe-ui-')));
  const env = createObserveEnvironment(root);
  const child = spawn(process.execPath, [path.resolve(__dirname, '../../index.js')], {
    cwd: root, env, stdio: 'inherit',
  });
  const cleanup = () => fs.rmSync(root, { recursive: true, force: true });
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
  child.on('exit', code => { cleanup(); process.exit(code || 0); });
  child.on('error', error => { cleanup(); console.error(error); process.exit(1); });
}

module.exports = { createObserveEnvironment };
if (require.main === module) startServer();
