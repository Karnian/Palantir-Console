const { Router } = require('express');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { asyncHandler } = require('../middleware/asyncHandler');

function createClaudeSessionsRouter() {
  const router = Router();
  const claudeDir = path.join(os.homedir(), '.claude');
  const sessionsDir = path.join(claudeDir, 'sessions');

  router.get('/', asyncHandler(async (req, res) => {
    let files;
    try {
      files = await fs.readdir(sessionsDir);
    } catch {
      return res.json({ sessions: [], error: 'Claude sessions directory not found' });
    }

    const sessions = [];
    for (const file of files) {
      if (!file.endsWith('.json')) continue;
      try {
        const raw = await fs.readFile(path.join(sessionsDir, file), 'utf8');
        const data = JSON.parse(raw);

        // Check if process is actually running
        let alive = false;
        try {
          process.kill(data.pid, 0); // signal 0 = just check
          alive = true;
        } catch {
          alive = false;
        }

        sessions.push({
          pid: data.pid,
          sessionId: data.sessionId,
          cwd: data.cwd,
          startedAt: data.startedAt,
          kind: data.kind || 'interactive',
          entrypoint: data.entrypoint || 'unknown',
          alive,
          // Extract project name from cwd
          projectName: path.basename(data.cwd.replace(/\/.claude\/worktrees\/[^/]+$/, '')),
          // Duration
          runningFor: Date.now() - data.startedAt,
        });
      } catch {
        // skip bad files
      }
    }

    // Sort: alive first, then by startedAt desc
    sessions.sort((a, b) => {
      if (a.alive !== b.alive) return a.alive ? -1 : 1;
      return b.startedAt - a.startedAt;
    });

    res.json({ sessions });
  }));

  return router;
}

module.exports = { createClaudeSessionsRouter };
