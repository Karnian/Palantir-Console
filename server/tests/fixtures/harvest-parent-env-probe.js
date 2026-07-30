'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHarvestService } = require('../../services/harvestService');
const { createLocalNodeExecutor } = require('../../services/nodeExecutor');

async function main() {
  process.env.PALANTIR_PROJECT_REPO = '1';
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'palantir-parent-env-probe-'));
  const workspace = path.join(root, 'workspace');
  const cache = path.join(root, 'cache');
  fs.mkdirSync(workspace);
  fs.mkdirSync(cache);
  const secret = process.env.PALANTIR_TOKEN;
  const command = process.platform === 'linux'
    ? `tr '\\0' '\\n' < /proc/$PPID/environ | grep '^PALANTIR_TOKEN=' || true`
    : `ps eww -p "$PPID" -o command= | tr ' ' '\\n' | grep '^PALANTIR_TOKEN=' || true`;
  const run = {
    id: 'run-parent-env-probe',
    project_id: 'project-parent-env-probe',
    is_manager: 0,
    status: 'completed',
    workspace_path: workspace,
    repo_cache_path: cache,
    resolved_commit: '0123456789012345678901234567890123456789',
    node_id: 'local',
  };
  const events = [];
  const localExecutor = createLocalNodeExecutor();
  const executor = {
    ...localExecutor,
    async fileExists() {
      return true;
    },
    async exec(bin, args, opts) {
      if (bin === 'git') return { code: 0, stdout: '', stderr: '' };
      return localExecutor.exec(bin, args, opts);
    },
  };
  const runService = {
    getRun() {
      return run;
    },
    getRunEvents() {
      return events;
    },
    addRunEvent(runId, eventType, payloadJson) {
      events.push({ run_id: runId, event_type: eventType, payload_json: payloadJson });
    },
  };
  const harvestService = createHarvestService({
    runService,
    worktreeService: {},
    projectService: {
      getProject() {
        return { id: run.project_id, test_command: command };
      },
    },
    eventBus: { emit() {} },
    nodeExecutor: executor,
    testRunner: { bin: '/bin/sh', args: ['-c'] },
  });

  try {
    await harvestService.harvestRun(run);
    const event = events.find((entry) => entry.event_type === 'harvest:test');
    if (!event) throw new Error('harvest:test was not emitted');
    const payload = JSON.parse(event.payload_json);
    process.stdout.write(JSON.stringify({
      output_tail: payload.output_tail,
      passed: payload.passed,
      secret,
    }));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

main().catch((err) => {
  process.stderr.write(`${err.stack || err}\n`);
  process.exitCode = 1;
});
