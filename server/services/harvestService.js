const { spawn, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { assertSpawnAllowed } = require('../utils/spawnGuard');

const MAX_STAT_CHARS = 8 * 1024;
const MAX_OUTPUT_TAIL_CHARS = 8 * 1024;
const MAX_SUMMARY_STAT_CHARS = 500;
const MAX_SUMMARY_OUTPUT_TAIL_CHARS = 500;
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
  eventBus,
  testRunner = { bin: '/bin/sh', args: ['-c'] },
} = {}) {
  const seenRunIds = new Set();

  function isReviewTargetRun(run) {
    return Boolean(
      run?.id
      && !run.is_manager
      && ['completed', 'failed'].includes(run.status)
    );
  }

  function createSummary() {
    return {
      files: 0,
      commits: 0,
      statText: '',
      test: null,
      errors: [],
      harvested: false,
    };
  }

  function pushSummaryError(summary, stage) {
    if (!summary.errors.includes(stage)) summary.errors.push(stage);
  }

  function latestRun(run) {
    try {
      return runService.getRun(run.id);
    } catch {
      return run;
    }
  }

  function emitHarvested(run, summary) {
    if (!eventBus) return;
    try {
      eventBus.emit('run:harvested', {
        run: latestRun(run),
        summary: {
          files: Number(summary.files) || 0,
          commits: Number(summary.commits) || 0,
          statText: capString(summary.statText || '', MAX_SUMMARY_STAT_CHARS).value,
          test: summary.test ? {
            passed: Boolean(summary.test.passed),
            timed_out: Boolean(summary.test.timed_out),
            exit_code: summary.test.exit_code ?? null,
            duration_ms: summary.test.duration_ms ?? null,
            output_tail: tailString(
              stripControlChars(summary.test.output_tail || ''),
              MAX_SUMMARY_OUTPUT_TAIL_CHARS
            ),
          } : null,
          errors: Array.isArray(summary.errors) ? [...summary.errors] : [],
          harvested: Boolean(summary.harvested),
        },
      });
    } catch {
      // harvestRun is annotate-only; subscribers must not make it throw.
    }
  }

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
    if (!isReviewTargetRun(run)) return;
    if (seenRunIds.has(run.id)) return;
    if (hasExistingHarvestEvent(run.id)) return;
    seenRunIds.add(run.id);

    const summary = createSummary();
    try {
      if (!run.worktree_path || !run.branch) {
        pushSummaryError(summary, 'no_worktree');
        emitHarvested(run, summary);
        return;
      }
      // Worktree already gone (e.g. executeTask's spawn-failure catch runs its
      // synchronous cleanup before this setImmediate fires). Review still needs
      // one terminal notification, but harvest itself cannot proceed.
      if (!fs.existsSync(run.worktree_path)) {
        pushSummaryError(summary, 'worktree_missing');
        emitHarvested(run, summary);
        return;
      }
      const resolved = resolveProject(run, projectDir);
      const resolvedProjectDir = resolved.projectDir;
      if (!resolvedProjectDir) {
        addError(run.id, 'preflight', new Error('Project directory unavailable'));
        pushSummaryError(summary, 'no_project_dir');
        emitHarvested(run, summary);
        return;
      }

      summary.harvested = true;
      try {
        worktreeService.autoSaveWorktree(run.worktree_path, run.id);
      } catch (err) {
        addError(run.id, 'autosave', err);
        pushSummaryError(summary, 'autosave');
      }

      try {
        const diff = worktreeService.getWorktreeDiff(resolvedProjectDir, run.branch);
        const base = diff.base || 'HEAD';
        let truncated = false;
        const cappedStat = capString(diff.stat || '', MAX_STAT_CHARS);
        truncated = truncated || cappedStat.truncated;
        const files = Array.isArray(diff.files) ? diff.files : [];
        if (files.length > MAX_FILES) truncated = true;
        summary.files = files.length;
        summary.statText = capString(diff.stat || '', MAX_SUMMARY_STAT_CHARS).value;
        let commits = [];
        try {
          const commitResult = listCommits(resolvedProjectDir, base, run.branch);
          commits = commitResult.commits;
          truncated = truncated || commitResult.truncated;
          summary.commits = commits.length;
        } catch (err) {
          addError(run.id, 'commits', err);
          pushSummaryError(summary, 'commits');
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
        pushSummaryError(summary, 'diff');
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
          summary.test = {
            passed: result.passed,
            timed_out: result.timed_out,
            exit_code: result.exit_code,
            duration_ms: result.duration_ms,
            output_tail: tailString(result.output_tail || '', MAX_SUMMARY_OUTPUT_TAIL_CHARS),
          };
        }
      } catch (err) {
        addError(run.id, 'test', err);
        pushSummaryError(summary, 'test');
      }

      try {
        worktreeService.removeWorktree(resolvedProjectDir, run.worktree_path, run.branch, {
          runId: run.id,
          autosave: false,
        });
      } catch (err) {
        addError(run.id, 'cleanup', err);
        pushSummaryError(summary, 'cleanup');
      }
      emitHarvested(run, summary);
    } catch (err) {
      try { addError(run?.id, 'fatal', err); } catch { /* never throw */ }
      pushSummaryError(summary, 'fatal');
      emitHarvested(run, summary);
    }
  }

  return { harvestRun };
}

module.exports = {
  createHarvestService,
  stripControlChars,
  buildHarvestEnv,
};
