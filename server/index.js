const express = require('express');
const path = require('path');
const os = require('os');
const fs = require('fs/promises');
const { spawn } = require('child_process');
const fg = require('fast-glob');
const crypto = require('crypto');

const app = express();
const port = process.env.PORT || 4177;
const opencodeBin = process.env.OPENCODE_BIN || 'opencode';

const storageRoot = process.env.OPENCODE_STORAGE || path.join(os.homedir(), '.local', 'share', 'opencode', 'storage');
const fsRoot = process.env.OPENCODE_FS_ROOT || os.homedir();
const sessionRoot = path.join(storageRoot, 'session');
const messageRoot = path.join(storageRoot, 'message');
const partRoot = path.join(storageRoot, 'part');
const trashRoot = path.join(storageRoot, 'trash', 'sessions');

app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

async function readJson(filePath) {
  const raw = await fs.readFile(filePath, 'utf8');
  return JSON.parse(raw);
}

async function writeJson(filePath, data) {
  const raw = JSON.stringify(data, null, 2);
  await fs.writeFile(filePath, `${raw}\n`, 'utf8');
}

async function listSessionFiles() {
  return fg('**/ses_*.json', { cwd: sessionRoot, absolute: true, onlyFiles: true });
}

async function findSessionFile(sessionId) {
  const files = await fg(`**/${sessionId}.json`, { cwd: sessionRoot, absolute: true, onlyFiles: true });
  return files[0] || null;
}

function computeStatus(now, lastActivity, lastRole) {
  if (!lastActivity) return 'idle';
  const ageMs = now - lastActivity;
  if (ageMs <= 60 * 1000) return 'running';
  if (lastRole === 'user' && ageMs <= 10 * 60 * 1000) return 'waiting';
  if (ageMs <= 60 * 60 * 1000) return 'idle';
  return 'stale';
}

async function getMessageMetas(sessionId) {
  const dir = path.join(messageRoot, sessionId);
  try {
    const files = await fg('msg_*.json', { cwd: dir, absolute: true, onlyFiles: true });
    const metas = await Promise.all(files.map(readJson));
    return metas;
  } catch (error) {
    return [];
  }
}

function sortByCreated(a, b) {
  const aTime = a?.time?.created || 0;
  const bTime = b?.time?.created || 0;
  return aTime - bTime;
}

async function getLastMessageInfo(sessionId) {
  const metas = await getMessageMetas(sessionId);
  if (!metas.length) return null;
  metas.sort(sortByCreated);
  const last = metas[metas.length - 1];
  return {
    lastActivity: last?.time?.created || 0,
    lastRole: last?.role || null,
    hasUserMessage: metas.some((meta) => meta?.role === 'user'),
    hasRunning: Boolean(last?.time?.created && !last?.time?.completed)
  };
}

async function loadSessions() {
  const now = Date.now();
  const files = await listSessionFiles();
  const sessions = [];

  for (const filePath of files) {
    try {
      const session = await readJson(filePath);
  const lastInfo = await getLastMessageInfo(session.id);
  const updatedAt = session?.time?.updated || session?.time?.created || 0;
  const lastActivity = Math.max(updatedAt, lastInfo?.lastActivity || 0);
  const status = lastInfo?.hasRunning
    ? 'running'
    : computeStatus(now, lastActivity, lastInfo?.lastRole);
      sessions.push({
        id: session.id,
        slug: session.slug,
        title: session.title || session.slug || session.id,
        directory: session.directory,
        projectId: session.projectID || null,
        version: session.version || null,
        createdAt: session?.time?.created || null,
        updatedAt: session?.time?.updated || null,
        summary: session.summary || null,
        lastActivity,
        status,
        hasUserMessage: lastInfo?.hasUserMessage ?? false
      });
    } catch (error) {
      continue;
    }
  }

  sessions.sort((a, b) => (b.lastActivity || 0) - (a.lastActivity || 0));
  return sessions;
}

async function loadSessionMeta(sessionId) {
  const file = await findSessionFile(sessionId);
  if (!file) return null;
  return readJson(file);
}

async function getDefaultSessionVersion() {
  const files = await listSessionFiles();
  if (!files.length) return null;
  const session = await readJson(files[0]);
  return session?.version || null;
}

function createSessionId() {
  return `ses_${crypto.randomBytes(12).toString('hex')}`;
}

async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true });
}

async function moveIfExists(source, destination) {
  try {
    await fs.rename(source, destination);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

async function moveSessionToTrash(sessionId) {
  const sessionFile = await findSessionFile(sessionId);
  if (!sessionFile) return null;

  const timestamp = Date.now();
  const sessionTrashRoot = path.join(trashRoot, `${timestamp}_${sessionId}`);
  await ensureDir(sessionTrashRoot);

  const moved = {
    sessionFile: false,
    messages: false,
    parts: 0,
    sessionDiff: false,
    todo: false
  };

  moved.sessionFile = await moveIfExists(sessionFile, path.join(sessionTrashRoot, path.basename(sessionFile)));

  const messageDir = path.join(messageRoot, sessionId);
  const messageTrashDir = path.join(sessionTrashRoot, 'message');
  try {
    const messageFiles = await fg('msg_*.json', { cwd: messageDir, absolute: true, onlyFiles: true });
    if (messageFiles.length) {
      await ensureDir(messageTrashDir);
    }
    for (const messageFile of messageFiles) {
      const base = path.basename(messageFile);
      const messageId = base.replace(/\.json$/, '');
      await moveIfExists(messageFile, path.join(messageTrashDir, base));

      const partDir = path.join(partRoot, messageId);
      const partTrashDir = path.join(sessionTrashRoot, 'part');
      await ensureDir(partTrashDir);
      const movedPart = await moveIfExists(partDir, path.join(partTrashDir, messageId));
      if (movedPart) moved.parts += 1;
    }
    moved.messages = messageFiles.length > 0;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }

  const diffDir = path.join(storageRoot, 'session_diff', sessionId);
  moved.sessionDiff = await moveIfExists(diffDir, path.join(sessionTrashRoot, 'session_diff'));

  const todoDir = path.join(storageRoot, 'todo', sessionId);
  moved.todo = await moveIfExists(todoDir, path.join(sessionTrashRoot, 'todo'));

  return { trashRoot: sessionTrashRoot, moved };
}

async function listTrashedSessions() {
  try {
    const entries = await fs.readdir(trashRoot, { withFileTypes: true });
    const items = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const folder = entry.name;
      const folderPath = path.join(trashRoot, folder);
      const sessionFiles = await fg('**/ses_*.json', { cwd: folderPath, absolute: true, onlyFiles: true });
      if (!sessionFiles.length) continue;
      const session = await readJson(sessionFiles[0]);
      const timestamp = Number(folder.split('_')[0]) || null;
      items.push({
        trashId: folder,
        trashedAt: timestamp,
        session
      });
    }
    items.sort((a, b) => (b.trashedAt || 0) - (a.trashedAt || 0));
    return items;
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

async function restoreTrashedSession(trashId) {
  const sessionTrashRoot = path.join(trashRoot, trashId);
  const sessionFiles = await fg('**/ses_*.json', { cwd: sessionTrashRoot, absolute: true, onlyFiles: true });
  if (!sessionFiles.length) return null;
  const session = await readJson(sessionFiles[0]);
  const sessionDir = path.join(sessionRoot, session.projectID || 'global');
  await ensureDir(sessionDir);
  const targetSessionFile = path.join(sessionDir, `${session.id}.json`);

  try {
    await fs.access(targetSessionFile);
    return { conflict: true };
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }

  await moveIfExists(sessionFiles[0], targetSessionFile);

  const messageTrashDir = path.join(sessionTrashRoot, 'message');
  try {
    const messageFiles = await fg('msg_*.json', { cwd: messageTrashDir, absolute: true, onlyFiles: true });
    if (messageFiles.length) {
      const messageDir = path.join(messageRoot, session.id);
      await ensureDir(messageDir);
      for (const messageFile of messageFiles) {
        const base = path.basename(messageFile);
        await moveIfExists(messageFile, path.join(messageDir, base));
      }
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }

  const partTrashDir = path.join(sessionTrashRoot, 'part');
  try {
    const partEntries = await fs.readdir(partTrashDir, { withFileTypes: true });
    for (const entry of partEntries) {
      if (!entry.isDirectory()) continue;
      const partId = entry.name;
      await moveIfExists(path.join(partTrashDir, partId), path.join(partRoot, partId));
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }

  const diffTrashDir = path.join(sessionTrashRoot, 'session_diff');
  await moveIfExists(diffTrashDir, path.join(storageRoot, 'session_diff', session.id));

  const todoTrashDir = path.join(sessionTrashRoot, 'todo');
  await moveIfExists(todoTrashDir, path.join(storageRoot, 'todo', session.id));

  await fs.rm(sessionTrashRoot, { recursive: true, force: true });
  return { session };
}

async function loadMessageParts(messageId) {
  const dir = path.join(partRoot, messageId);
  try {
    const files = await fg('prt_*.json', { cwd: dir, absolute: true, onlyFiles: true });
    const parts = await Promise.all(files.map(readJson));
    parts.sort((a, b) => (a?.time?.start || 0) - (b?.time?.start || 0));
    return parts;
  } catch (error) {
    return [];
  }
}

function truncateText(text, limit = 1200) {
  if (typeof text !== 'string') return '';
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}\n... [truncated]`;
}

function summarizeToolInput(input) {
  if (!input) return '';
  if (typeof input === 'string') return input;
  if (typeof input !== 'object') return String(input);
  if (input.command) return input.command;
  if (input.filePath) return input.filePath;
  if (input.path) return input.path;
  if (input.url) return input.url;
  if (input.query) return input.query;
  try {
    return JSON.stringify(input);
  } catch (error) {
    return '';
  }
}

function formatToolPart(part) {
  const toolName = part.tool || 'tool';
  const title = part.state?.title || part.state?.metadata?.description || '';
  const header = title ? `[tool:${toolName}] ${title}` : `[tool:${toolName}]`;
  const inputLine = summarizeToolInput(part.state?.input);
  const outputSource = part.state?.metadata?.preview || part.state?.output || part.state?.metadata?.output || '';
  const output = truncateText(outputSource);

  const lines = [header];
  if (inputLine) lines.push(`input: ${inputLine}`);
  if (output) lines.push(`output:\n${output}`);
  return lines.join('\n');
}

function mergeParts(parts) {
  return parts
    .map((part) => {
      if (part.type === 'text' && typeof part.text === 'string') {
        return part.text;
      }
      if (part.type === 'reasoning' && typeof part.text === 'string' && part.text.trim()) {
        return part.text;
      }
      if (part.type === 'tool') {
        return formatToolPart(part);
      }
      return '';
    })
    .filter((chunk) => chunk && chunk.trim())
    .join('\n\n');
}

async function loadSessionMessages(sessionId, limit = 200) {
  const metas = await getMessageMetas(sessionId);
  metas.sort(sortByCreated);
  const slice = metas.slice(Math.max(0, metas.length - limit));
  const messages = [];

  for (const meta of slice) {
    const parts = await loadMessageParts(meta.id);
    const content = mergeParts(parts);
    messages.push({
      id: meta.id,
      sessionId: meta.sessionID,
      role: meta.role,
      createdAt: meta?.time?.created || null,
      completedAt: meta?.time?.completed || null,
      agent: meta.agent || meta.mode || null,
      providerId: meta.providerID || meta.model?.providerID || null,
      modelId: meta.modelID || meta.model?.modelID || null,
      path: meta.path || null,
      content
    });
  }

  return messages;
}

async function resolveCwd(sessionDir) {
  if (!sessionDir) return process.cwd();
  try {
    await fs.access(sessionDir);
    return sessionDir;
  } catch (error) {
    return process.cwd();
  }
}

function isWithinRoot(rootDir, targetPath) {
  const rootResolved = path.resolve(rootDir);
  const targetResolved = path.resolve(targetPath);
  return targetResolved === rootResolved || targetResolved.startsWith(`${rootResolved}${path.sep}`);
}

app.get('/api/sessions', async (req, res) => {
  try {
    const sessions = await loadSessions();
    res.json({ sessions, storageRoot });
  } catch (error) {
    res.status(500).json({ error: 'Failed to load sessions' });
  }
});

app.get('/api/fs', async (req, res) => {
  const requested = typeof req.query.path === 'string' && req.query.path.trim() ? req.query.path.trim() : fsRoot;
  const showHidden = req.query.showHidden === '1' || req.query.showHidden === 'true';
  const resolved = path.resolve(requested);
  if (!isWithinRoot(fsRoot, resolved)) {
    res.status(403).json({ error: 'Path not allowed' });
    return;
  }

  try {
    const entries = await fs.readdir(resolved, { withFileTypes: true });
    const directories = entries
      .filter((entry) => entry.isDirectory())
      .filter((entry) => showHidden || !entry.name.startsWith('.'))
      .map((entry) => ({
        name: entry.name,
        path: path.join(resolved, entry.name)
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
    res.json({ root: fsRoot, path: resolved, directories });
  } catch (error) {
    if (error.code === 'ENOENT') {
      res.status(404).json({ error: 'Path not found' });
      return;
    }
    if (error.code === 'EACCES') {
      res.status(403).json({ error: 'Access denied' });
      return;
    }
    res.status(500).json({ error: 'Failed to read directory' });
  }
});

app.get('/api/sessions/:id', async (req, res) => {
  const { id } = req.params;
  const limit = Number(req.query.limit || 200);
  try {
    const session = await loadSessionMeta(id);
    const messages = await loadSessionMessages(id, limit);
    res.json({ session, messages });
  } catch (error) {
    res.status(500).json({ error: 'Failed to load session' });
  }
});

app.post('/api/sessions', async (req, res) => {
  const { title, projectId, directory } = req.body || {};
  if (!title || typeof title !== 'string') {
    res.status(400).json({ error: 'title is required' });
    return;
  }

  try {
    const id = createSessionId();
    const now = Date.now();
    const version = await getDefaultSessionVersion();
    const session = {
      id,
      version: version || '1.0.0',
      projectID: projectId || 'global',
      directory: directory || null,
      title: title.trim(),
      time: {
        created: now,
        updated: now
      },
      summary: {
        additions: 0,
        deletions: 0,
        files: 0
      }
    };

    const sessionDir = path.join(sessionRoot, session.projectID || 'global');
    await ensureDir(sessionDir);
    await writeJson(path.join(sessionDir, `${id}.json`), session);
    res.status(201).json({ session });
  } catch (error) {
    res.status(500).json({ error: 'Failed to create session' });
  }
});

app.patch('/api/sessions/:id', async (req, res) => {
  const { id } = req.params;
  const { title } = req.body || {};
  if (!title || typeof title !== 'string') {
    res.status(400).json({ error: 'title is required' });
    return;
  }

  try {
    const sessionFile = await findSessionFile(id);
    if (!sessionFile) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }
    const session = await readJson(sessionFile);
    session.title = title.trim();
    session.time = session.time || {};
    session.time.updated = Date.now();
    await writeJson(sessionFile, session);
    res.json({ session });
  } catch (error) {
    res.status(500).json({ error: 'Failed to rename session' });
  }
});

app.delete('/api/sessions/:id', async (req, res) => {
  const { id } = req.params;
  try {
    const result = await moveSessionToTrash(id);
    if (!result) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }
    res.json({ status: 'ok', trashRoot: result.trashRoot, moved: result.moved });
  } catch (error) {
    res.status(500).json({ error: 'Failed to delete session' });
  }
});

app.get('/api/trash/sessions', async (req, res) => {
  try {
    const items = await listTrashedSessions();
    res.json({ items });
  } catch (error) {
    res.status(500).json({ error: 'Failed to load trash' });
  }
});

app.post('/api/trash/sessions/:trashId/restore', async (req, res) => {
  const { trashId } = req.params;
  try {
    const result = await restoreTrashedSession(trashId);
    if (!result) {
      res.status(404).json({ error: 'Trash item not found' });
      return;
    }
    if (result.conflict) {
      res.status(409).json({ error: 'Session already exists' });
      return;
    }
    res.json({ status: 'ok', session: result.session });
  } catch (error) {
    res.status(500).json({ error: 'Failed to restore session' });
  }
});

app.delete('/api/trash/sessions/:trashId', async (req, res) => {
  const { trashId } = req.params;
  const sessionTrashRoot = path.join(trashRoot, trashId);
  try {
    await fs.rm(sessionTrashRoot, { recursive: true, force: true });
    res.json({ status: 'ok' });
  } catch (error) {
    res.status(500).json({ error: 'Failed to delete trash item' });
  }
});

app.post('/api/sessions/:id/message', async (req, res) => {
  const { id } = req.params;
  const { content } = req.body || {};
  if (!content || typeof content !== 'string') {
    res.status(400).json({ error: 'content is required' });
    return;
  }

  try {
    const session = await loadSessionMeta(id);
    const cwd = await resolveCwd(session?.directory);
    const child = spawn(opencodeBin, ['run', '--session', id, content], {
      cwd,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        NODE_TLS_REJECT_UNAUTHORIZED: process.env.NODE_TLS_REJECT_UNAUTHORIZED || '0'
      }
    });
    let responded = false;

    const sendResponse = (payload, status = 200) => {
      if (responded || res.headersSent) return;
      responded = true;
      res.status(status).json(payload);
    };

    child.on('error', (spawnError) => {
      sendResponse({
        error: 'Failed to launch opencode',
        details: spawnError.message
      }, 500);
    });

    child.on('spawn', () => {
      sendResponse({ status: 'ok', queued: true });
      child.unref();
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to send message' });
  }
});

app.listen(port, () => {
  console.log(`Palantir Console running at http://localhost:${port}`);
});
