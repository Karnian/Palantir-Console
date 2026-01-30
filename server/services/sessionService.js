const path = require('path');
const crypto = require('crypto');

function createSessionService(storage) {
  function computeStatus(now, lastActivity, lastRole) {
    if (!lastActivity) return 'idle';
    const ageMs = now - lastActivity;
    if (ageMs <= 60 * 1000) return 'running';
    if (lastRole === 'user' && ageMs <= 10 * 60 * 1000) return 'waiting';
    if (ageMs <= 60 * 60 * 1000) return 'idle';
    return 'stale';
  }

  function sortByCreated(a, b) {
    const aTime = a?.time?.created || 0;
    const bTime = b?.time?.created || 0;
    return aTime - bTime;
  }

  function getProviderModel(meta) {
    if (!meta) return { providerId: null, modelId: null };
    return {
      providerId: meta.providerID || meta.model?.providerID || null,
      modelId: meta.modelID || meta.model?.modelID || null
    };
  }

  function getLastProviderModel(metas) {
    for (let index = metas.length - 1; index >= 0; index -= 1) {
      const { providerId, modelId } = getProviderModel(metas[index]);
      if (providerId || modelId) {
        return { lastProviderId: providerId, lastModelId: modelId };
      }
    }
    return { lastProviderId: null, lastModelId: null };
  }

  async function getLastMessageInfo(sessionId) {
    const metas = await storage.getMessageMetas(sessionId);
    if (!metas.length) return null;
    metas.sort(sortByCreated);
    const last = metas[metas.length - 1];
    const lastProviderModel = getLastProviderModel(metas);
    return {
      lastActivity: last?.time?.created || 0,
      lastRole: last?.role || null,
      hasUserMessage: metas.some((meta) => meta?.role === 'user'),
      hasRunning: Boolean(last?.time?.created && !last?.time?.completed),
      lastProviderId: lastProviderModel.lastProviderId,
      lastModelId: lastProviderModel.lastModelId
    };
  }

  async function loadSessions() {
    const now = Date.now();
    const files = await storage.listSessionFiles();
    const sessions = [];

    for (const filePath of files) {
      try {
        const session = await storage.readJson(filePath);
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
          hasUserMessage: lastInfo?.hasUserMessage ?? false,
          lastProviderId: lastInfo?.lastProviderId || null,
          lastModelId: lastInfo?.lastModelId || null
        });
      } catch (error) {
        continue;
      }
    }

    sessions.sort((a, b) => (b.lastActivity || 0) - (a.lastActivity || 0));
    return sessions;
  }

  async function loadSessionMeta(sessionId) {
    const file = await storage.findSessionFile(sessionId);
    if (!file) return null;
    return storage.readJson(file);
  }

  async function getDefaultSessionVersion() {
    const files = await storage.listSessionFiles();
    if (!files.length) return null;
    const session = await storage.readJson(files[0]);
    return session?.version || null;
  }

  function createSessionId() {
    return `ses_${crypto.randomBytes(12).toString('hex')}`;
  }

  async function createSession({ title, projectId, directory }) {
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

    const sessionDir = path.join(storage.sessionRoot, session.projectID || 'global');
    await storage.ensureDir(sessionDir);
    await storage.writeJson(path.join(sessionDir, `${id}.json`), session);
    return session;
  }

  async function renameSession(sessionId, title) {
    const sessionFile = await storage.findSessionFile(sessionId);
    if (!sessionFile) return null;
    const session = await storage.readJson(sessionFile);
    session.title = title.trim();
    session.time = session.time || {};
    session.time.updated = Date.now();
    await storage.writeJson(sessionFile, session);
    return session;
  }

  return {
    loadSessions,
    loadSessionMeta,
    createSession,
    renameSession
  };
}

module.exports = { createSessionService };
