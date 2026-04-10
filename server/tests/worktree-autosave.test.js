const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { createWorktreeService } = require('../services/worktreeService');

// Create a temporary git repo for testing
function makeTempRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'palantir-wt-test-'));
  execFileSync('git', ['init', '-b', 'main'], { cwd: dir, stdio: 'pipe' });
  execFileSync('git', ['config', 'user.email', 'test@test.com'], { cwd: dir, stdio: 'pipe' });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: dir, stdio: 'pipe' });
  // Initial commit so branches can be created
  fs.writeFileSync(path.join(dir, 'README.md'), '# test\n');
  execFileSync('git', ['add', '.'], { cwd: dir, stdio: 'pipe' });
  execFileSync('git', ['commit', '-m', 'init'], { cwd: dir, stdio: 'pipe' });
  return dir;
}

function cleanup(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
}

describe('worktreeService auto-save on removal', () => {
  let repoDir;
  let ws;

  before(() => {
    repoDir = makeTempRepo();
    ws = createWorktreeService();
  });

  after(() => {
    cleanup(repoDir);
  });

  it('auto-commits uncommitted changes before removing worktree', () => {
    const { path: wtPath, branch } = ws.createWorktree(repoDir, 'palantir/auto-save-test');
    assert.ok(fs.existsSync(wtPath), 'worktree should be created');

    // Create an uncommitted file in the worktree
    fs.writeFileSync(path.join(wtPath, 'work-in-progress.txt'), 'important work\n');

    // Verify the file exists and is uncommitted
    assert.ok(ws.hasUncommittedChanges(wtPath), 'should detect uncommitted changes');

    // Remove worktree — should auto-save first
    ws.removeWorktree(repoDir, wtPath, branch, { runId: 'test-run-1' });

    // Worktree directory should be gone
    assert.ok(!fs.existsSync(wtPath), 'worktree directory should be removed');

    // Branch should be preserved because it has commits ahead of base
    assert.ok(ws.branchHasWork(repoDir, branch), 'branch should have work');

    // Verify the auto-save commit exists on the branch
    const log = execFileSync('git', ['log', '--oneline', branch, '-1'], {
      cwd: repoDir, stdio: 'pipe', encoding: 'utf-8',
    });
    assert.ok(log.includes('[palantir] auto-save'), 'should have auto-save commit');
    assert.ok(log.includes('test-run-1'), 'should include run ID in commit message');

    // Verify the file is in the commit
    const files = execFileSync('git', ['diff', '--name-only', `main..${branch}`], {
      cwd: repoDir, stdio: 'pipe', encoding: 'utf-8',
    });
    assert.ok(files.includes('work-in-progress.txt'), 'auto-saved file should be in the commit');

    // Cleanup: delete the preserved branch
    try { execFileSync('git', ['branch', '-D', branch], { cwd: repoDir, stdio: 'pipe' }); } catch { /* ok */ }
  });

  it('deletes branch when worktree has no changes', () => {
    const { path: wtPath, branch } = ws.createWorktree(repoDir, 'palantir/clean-wt-test');
    assert.ok(fs.existsSync(wtPath), 'worktree should be created');

    // No changes made — remove should delete the branch
    ws.removeWorktree(repoDir, wtPath, branch, { runId: 'test-run-2' });

    assert.ok(!fs.existsSync(wtPath), 'worktree should be removed');
    // Branch should be deleted (no work to preserve)
    let branchExists = true;
    try {
      execFileSync('git', ['rev-parse', '--verify', branch], { cwd: repoDir, stdio: 'pipe' });
    } catch {
      branchExists = false;
    }
    assert.ok(!branchExists, 'branch should be deleted when no work was done');
  });

  it('preserves branch when worker committed changes (no auto-save needed)', () => {
    const { path: wtPath, branch } = ws.createWorktree(repoDir, 'palantir/committed-test');

    // Simulate worker committing work normally
    fs.writeFileSync(path.join(wtPath, 'committed-work.txt'), 'already committed\n');
    execFileSync('git', ['add', '.'], { cwd: wtPath, stdio: 'pipe' });
    execFileSync('git', ['commit', '-m', 'worker commit'], { cwd: wtPath, stdio: 'pipe' });

    // No uncommitted changes
    assert.ok(!ws.hasUncommittedChanges(wtPath), 'should have no uncommitted changes');

    // Remove worktree
    ws.removeWorktree(repoDir, wtPath, branch, { runId: 'test-run-3' });

    // Branch should be preserved (has commits)
    assert.ok(ws.branchHasWork(repoDir, branch), 'branch should be preserved');

    // Cleanup
    try { execFileSync('git', ['branch', '-D', branch], { cwd: repoDir, stdio: 'pipe' }); } catch { /* ok */ }
  });

  it('hasUncommittedChanges returns false for clean worktree', () => {
    const { path: wtPath, branch } = ws.createWorktree(repoDir, 'palantir/clean-check');
    assert.ok(!ws.hasUncommittedChanges(wtPath), 'clean worktree should have no uncommitted changes');
    ws.removeWorktree(repoDir, wtPath, branch);
  });
});
