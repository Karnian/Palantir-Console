const { spawn, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { assertSpawnAllowed } = require('../utils/spawnGuard');

const MAX_STAT_CHARS = 8 * 1024;
const MAX_OUTPUT_TAIL_CHARS = 8 * 1024;
const MAX_FILES = 500;
const MAX_COMMITS = 50;
const DEFAULT_TEST_TIMEOUT_MS = 300_000;

function tailString(value, maxChars) {
  const text = String(value || '');
  if (text.length <= maxChars) return text;
  return text.slice(text.length - maxChars);
}

function capString(value, maxChars) {
  const text = String(value || '');
  if (text.length <= maxChars) return { value: text, truncated: false };
  return { value: text.slice(0, maxChars), truncated: true };
}

function stripControlChars(value) {
  return String(value || '')
    .replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');
}

function testTimeoutMs() {
  const raw = Number(process.env.PALANTIR_HARVEST_TEST_TIMEOUT_MS || DEFAULT_TEST_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_TEST_TIMEOUT_MS;
}

function buildHarvestEnv() {
  const extraPaths = ['/opt/homebrew/bin', '/opt/homebrew/sbin', '/usr/local/bin'];
  const currentPath = process.env.PATH || '';
  const env = {
    PATH: [...extraPaths, currentPath].filter(Boolean).join(path.delimiter),
  };
  if (process.env.HOME) env.HOME = process.env.HOME;
  if (process.env.LANG) env.LANG = process.env.LANG;
  return env;
}

function runTestCommand({ command, cwd, testRunner }) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const timeoutMs = testTimeoutMs();
    const args = [...(testRunner.args || []), command];
    assertSpawnAllowed({ command: testRunner.bin, source: 'harvestService:test' });

    let output = '';
    let timedOut = false;
    let settled = false;
    const child = spawn(testRunner.bin, args, {
      cwd,
      env: buildHarvestEnv(),
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: false,
    });

    const appendOutput = (chunk) => {
      output = tailString(output + chunk.toString('utf8'), MAX_OUTPUT_TAIL_CHARS * 2);
    };
    child.stdout.on('data', appendOutput);
    child.stderr.on('data', appendOutput);

    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill('SIGKILL'); } catch { /* best effort */ }
    }, timeoutMs);

    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });

    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const outputTail = tailString(stripControlChars(output), MAX_OUTPUT_TAIL_CHARS);
      resolve({
        command,
        exit_code: timedOut ? null : code,
        passed: !timedOut && code === 0,
        timed_out: timedOut,
        duration_ms: Date.now() - started,
        output_tail: outputTail,
      });
    });
  });
}

function createHarvestService({
  runService,
  worktreeService,
  projectService,
  testRunner = { bin: '/bin/sh', args: ['-c'] },
} = {}) {
  const seenRunIds = new Set();

  function hasExistingHarvestEvent(runId) {
    try {
      return (runService.getRunEvents(runId) || []).some((evt) => (
        evt.event_type === 'harvest:diff' || evt.event_type === 'harvest:error'
      ));
    } catch {
      return false;
    }
  }

  function addEvent(runId, eventType, payload) {
    try {
      runService.addRunEvent(runId, eventType, JSON.stringify(payload));
      return true;
    } catch {
      return false;
    }
  }

  function addError(runId, stage, err) {
    return addEvent(runId, 'harvest:error', {
      stage,
      error: err?.message || String(err || 'unknown error'),
    });
  }

  function resolveProject(run, projectDir) {
    if (run?.project_id && projectService) {
      try {
        const project = projectService.getProject(run.project_id);
        return { project, projectDir: projectDir || project.directory || null };
      } catch {
        return { project: null, projectDir: projectDir || null };
      }
    }
    return { project: null, projectDir: projectDir || null };
  }

  function listCommits(projectDir, base, branch) {
    const gitEnv = { ...process.env, GIT_EXTERNAL_DIFF: '', GIT_TEXTCONV_DIFF: '' };
    const output = execFileSync(
      'git',
      ['log', '--no-color', '--oneline', `--max-count=${MAX_COMMITS + 1}`, `${base}..${branch}`],
      { cwd: projectDir, stdio: 'pipe', encoding: 'utf-8', env: gitEnv },
    );
    const lines = output.trim().split('\n').filter(Boolean);
    return {
      commits: lines.slice(0, MAX_COMMITS),
      truncated: lines.length > MAX_COMMITS,
    };
  }

  async function harvestRun(run, { projectDir } = {}) {
    try {
      if (!run?.id) return;
      if (run.is_manager) return;
      if (!['completed', 'failed'].includes(run.status)) return;
      if (!run.worktree_path || !run.branch) return;
      // Worktree already gone (e.g. executeTask's spawn-failure catch runs its
      // synchronous cleanup before this setImmediate fires) — nothing to
      // harvest, and proceeding would only emit noise events.
      if (!fs.existsSync(run.worktree_path)) return;
      if (seenRunIds.has(run.id)) return;
      seenRunIds.add(run.id);
      if (hasExistingHarvestEvent(run.id)) return;

      const resolved = resolveProject(run, projectDir);
      const resolvedProjectDir = resolved.projectDir;
      if (!resolvedProjectDir) {
        addError(run.id, 'preflight', new Error('Project directory unavailable'));
        return;
      }

      try {
        worktreeService.autoSaveWorktree(run.worktree_path, run.id);
      } catch (err) {
        addError(run.id, 'autosave', err);
      }

      try {
        const diff = worktreeService.getWorktreeDiff(resolvedProjectDir, run.branch);
        const base = diff.base || 'HEAD';
        let truncated = false;
        const cappedStat = capString(diff.stat || '', MAX_STAT_CHARS);
        truncated = truncated || cappedStat.truncated;
        const files = Array.isArray(diff.files) ? diff.files : [];
        if (files.length > MAX_FILES) truncated = true;
        let commits = [];
        try {
          const commitResult = listCommits(resolvedProjectDir, base, run.branch);
          commits = commitResult.commits;
          truncated = truncated || commitResult.truncated;
        } catch (err) {
          addError(run.id, 'commits', err);
        }
        addEvent(run.id, 'harvest:diff', {
          base,
          branch: run.branch,
          stat: cappedStat.value,
          files: files.slice(0, MAX_FILES),
          commits,
          truncated,
        });
      } catch (err) {
        addError(run.id, 'diff', err);
      }

      try {
        const command = resolved.project?.test_command || null;
        if (command && run.status === 'completed') {
          const result = await runTestCommand({
            command,
            cwd: run.worktree_path,
            testRunner,
          });
          addEvent(run.id, 'harvest:test', result);
        }
      } catch (err) {
        addError(run.id, 'test', err);
      }

      try {
        worktreeService.removeWorktree(resolvedProjectDir, run.worktree_path, run.branch, {
          runId: run.id,
          autosave: false,
        });
      } catch (err) {
        addError(run.id, 'cleanup', err);
      }
    } catch (err) {
      try { addError(run?.id, 'fatal', err); } catch { /* never throw */ }
    }
  }

  return { harvestRun };
}

module.exports = {
  createHarvestService,
  stripControlChars,
  buildHarvestEnv,
};
