const { execFileSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');

/**
 * Git worktree manager — creates isolated worktrees for agent runs.
 * Each agent executes in its own worktree to prevent file conflicts.
 */

function createWorktreeService() {
  /**
   * Validate branch name: only allow safe characters (alphanumeric, hyphens, underscores, slashes, dots).
   * Prevents path traversal and command injection.
   */
  function validateBranchName(name) {
    if (!name || typeof name !== 'string') {
      throw new Error('Branch name is required');
    }
    // Reject path traversal
    if (name.includes('..') || name.startsWith('/') || name.startsWith('-')) {
      throw new Error(`Invalid branch name: ${name}`);
    }
    // Only allow safe git branch name characters
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._/-]*$/.test(name)) {
      throw new Error(`Invalid branch name characters: ${name}`);
    }
    return name;
  }

  function isGitRepo(dir) {
    try {
      execFileSync('git', ['rev-parse', '--git-dir'], { cwd: dir, stdio: 'pipe' });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Resolve the base ref to branch a new worktree from. Falls back from the
   * current branch name → HEAD sha (detached HEAD case) → 'main'. Returning
   * something usable here is critical: an empty value would make the downstream
   * `git branch <new> ''` call fail and silently disable worktree isolation.
   */
  function getCurrentBranch(dir) {
    try {
      const branch = execFileSync('git', ['branch', '--show-current'], { cwd: dir, stdio: 'pipe', encoding: 'utf-8' }).trim();
      if (branch) return branch;
    } catch { /* fall through */ }
    try {
      const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, stdio: 'pipe', encoding: 'utf-8' }).trim();
      if (sha) return sha;
    } catch { /* fall through */ }
    return 'main';
  }

  /**
   * Create a new git worktree for an agent run.
   * @param {string} projectDir - The git repository root
   * @param {string} branchName - Branch name for the worktree
   * @returns {{ path: string, branch: string, created: boolean }}
   */
  function createWorktree(projectDir, branchName) {
    if (!isGitRepo(projectDir)) {
      return { path: projectDir, branch: null, created: false };
    }

    const safeBranch = validateBranchName(branchName);
    const worktreesBase = path.join(projectDir, '.palantir-worktrees');
    const worktreePath = path.join(worktreesBase, safeBranch);

    // Verify the resolved path is still under worktreesBase (prevent traversal)
    const resolvedPath = path.resolve(worktreePath);
    const resolvedBase = path.resolve(worktreesBase);
    if (!resolvedPath.startsWith(resolvedBase + path.sep)) {
      throw new Error(`Worktree path escapes base directory: ${branchName}`);
    }

    // If worktree already exists, return it
    if (fs.existsSync(worktreePath)) {
      return { path: worktreePath, branch: safeBranch, created: false };
    }

    // Track whether we created the branch ourselves so partial-failure cleanup
    // (after the branch exists but `git worktree add` failed) doesn't strand it.
    let branchPreexisted = true;
    try {
      // Ensure base directory exists
      fs.mkdirSync(worktreesBase, { recursive: true });

      // Create new branch from current HEAD — all args as arrays (no shell)
      const baseBranch = getCurrentBranch(projectDir);
      try {
        execFileSync('git', ['branch', safeBranch, baseBranch], { cwd: projectDir, stdio: 'pipe' });
        branchPreexisted = false;
      } catch {
        // Branch already existed; leave it alone on rollback
      }

      execFileSync('git', ['worktree', 'add', worktreePath, safeBranch], {
        cwd: projectDir,
        stdio: 'pipe',
      });

      return { path: worktreePath, branch: safeBranch, created: true };
    } catch (error) {
      console.error(`[worktreeService] Failed to create worktree: ${error.message}`);
      // Roll back the freshly-created branch so it doesn't strand as `palantir/...` debris.
      // Pre-existing branches are left untouched.
      if (!branchPreexisted) {
        try {
          execFileSync('git', ['branch', '-D', safeBranch], { cwd: projectDir, stdio: 'pipe' });
        } catch { /* best effort */ }
      }
      // Fallback: use project directory directly
      return { path: projectDir, branch: null, created: false };
    }
  }

  /**
   * Remove a worktree and optionally its branch.
   */
  function removeWorktree(projectDir, worktreePath, branchName) {
    // Validate worktreePath is within projectDir to prevent arbitrary deletion
    const resolvedProject = path.resolve(projectDir);
    const resolvedWorktree = path.resolve(worktreePath);
    if (!resolvedWorktree.startsWith(resolvedProject + path.sep) && resolvedWorktree !== resolvedProject) {
      throw new Error(`Worktree path ${worktreePath} is outside project directory ${projectDir}`);
    }

    try {
      execFileSync('git', ['worktree', 'remove', resolvedWorktree, '--force'], {
        cwd: projectDir,
        stdio: 'pipe',
      });
    } catch (error) {
      console.error(`[worktreeService] Failed to remove worktree: ${error.message}`);
      // Try manual cleanup — only if path is confirmed inside project dir
      try {
        if (fs.existsSync(resolvedWorktree) && fs.statSync(resolvedWorktree).isDirectory()) {
          fs.rmSync(resolvedWorktree, { recursive: true, force: true });
        }
        execFileSync('git', ['worktree', 'prune'], { cwd: projectDir, stdio: 'pipe' });
      } catch {
        // best effort
      }
    }

    if (branchName) {
      try {
        const safeBranch = validateBranchName(branchName);
        execFileSync('git', ['branch', '-D', safeBranch], { cwd: projectDir, stdio: 'pipe' });
      } catch {
        // branch may have been merged or doesn't exist
      }
    }
  }

  /**
   * List all active worktrees for a project.
   */
  function listWorktrees(projectDir) {
    if (!isGitRepo(projectDir)) return [];
    try {
      const output = execFileSync('git', ['worktree', 'list', '--porcelain'], {
        cwd: projectDir,
        stdio: 'pipe',
        encoding: 'utf-8',
      });

      const worktrees = [];
      let current = {};

      for (const line of output.split('\n')) {
        if (line.startsWith('worktree ')) {
          if (current.path) worktrees.push(current);
          current = { path: line.slice(9) };
        } else if (line.startsWith('HEAD ')) {
          current.head = line.slice(5);
        } else if (line.startsWith('branch ')) {
          current.branch = line.slice(7).replace('refs/heads/', '');
        } else if (line === 'detached') {
          current.detached = true;
        }
      }
      if (current.path) worktrees.push(current);

      return worktrees;
    } catch {
      return [];
    }
  }

  /**
   * Get diff summary for a worktree branch vs main.
   */
  function getWorktreeDiff(projectDir, branchName) {
    try {
      const safeBranch = validateBranchName(branchName);
      const baseBranch = getCurrentBranch(projectDir);
      const stat = execFileSync(
        'git', ['diff', `${baseBranch}...${safeBranch}`, '--stat'],
        { cwd: projectDir, stdio: 'pipe', encoding: 'utf-8' }
      );
      const diffOutput = execFileSync(
        'git', ['diff', `${baseBranch}...${safeBranch}`, '--name-only'],
        { cwd: projectDir, stdio: 'pipe', encoding: 'utf-8' }
      );
      return {
        stat: stat.trim(),
        files: diffOutput.trim().split('\n').filter(Boolean),
      };
    } catch {
      return { stat: '', files: [] };
    }
  }

  return { createWorktree, removeWorktree, listWorktrees, getWorktreeDiff, isGitRepo };
}

module.exports = { createWorktreeService };
