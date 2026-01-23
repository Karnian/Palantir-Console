const path = require('path');
const fs = require('fs/promises');
const fg = require('fast-glob');

function createTrashService(storage) {
  async function moveSessionToTrash(sessionId) {
    const sessionFile = await storage.findSessionFile(sessionId);
    if (!sessionFile) return null;

    const timestamp = Date.now();
    const sessionTrashRoot = path.join(storage.trashRoot, `${timestamp}_${sessionId}`);
    await storage.ensureDir(sessionTrashRoot);

    const moved = {
      sessionFile: false,
      messages: false,
      parts: 0,
      sessionDiff: false,
      todo: false
    };

    moved.sessionFile = await storage.moveIfExists(sessionFile, path.join(sessionTrashRoot, path.basename(sessionFile)));

    const messageDir = path.join(storage.messageRoot, sessionId);
    const messageTrashDir = path.join(sessionTrashRoot, 'message');
    try {
      const messageFiles = await fg('msg_*.json', { cwd: messageDir, absolute: true, onlyFiles: true });
      if (messageFiles.length) {
        await storage.ensureDir(messageTrashDir);
      }
      for (const messageFile of messageFiles) {
        const base = path.basename(messageFile);
        const messageId = base.replace(/\.json$/, '');
        await storage.moveIfExists(messageFile, path.join(messageTrashDir, base));

        const partDir = path.join(storage.partRoot, messageId);
        const partTrashDir = path.join(sessionTrashRoot, 'part');
        await storage.ensureDir(partTrashDir);
        const movedPart = await storage.moveIfExists(partDir, path.join(partTrashDir, messageId));
        if (movedPart) moved.parts += 1;
      }
      moved.messages = messageFiles.length > 0;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }

    const diffDir = path.join(storage.storageRoot, 'session_diff', sessionId);
    moved.sessionDiff = await storage.moveIfExists(diffDir, path.join(sessionTrashRoot, 'session_diff'));

    const todoDir = path.join(storage.storageRoot, 'todo', sessionId);
    moved.todo = await storage.moveIfExists(todoDir, path.join(sessionTrashRoot, 'todo'));

    return { trashRoot: sessionTrashRoot, moved };
  }

  async function listTrashedSessions() {
    try {
      const entries = await fs.readdir(storage.trashRoot, { withFileTypes: true });
      const items = [];
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const folder = entry.name;
        const folderPath = path.join(storage.trashRoot, folder);
        const sessionFiles = await fg('**/ses_*.json', { cwd: folderPath, absolute: true, onlyFiles: true });
        if (!sessionFiles.length) continue;
        const session = await storage.readJson(sessionFiles[0]);
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
    const sessionTrashRoot = path.join(storage.trashRoot, trashId);
    const sessionFiles = await fg('**/ses_*.json', { cwd: sessionTrashRoot, absolute: true, onlyFiles: true });
    if (!sessionFiles.length) return null;
    const session = await storage.readJson(sessionFiles[0]);
    const sessionDir = path.join(storage.sessionRoot, session.projectID || 'global');
    await storage.ensureDir(sessionDir);
    const targetSessionFile = path.join(sessionDir, `${session.id}.json`);

    try {
      await fs.access(targetSessionFile);
      return { conflict: true };
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }

    await storage.moveIfExists(sessionFiles[0], targetSessionFile);

    const messageTrashDir = path.join(sessionTrashRoot, 'message');
    try {
      const messageFiles = await fg('msg_*.json', { cwd: messageTrashDir, absolute: true, onlyFiles: true });
      if (messageFiles.length) {
        const messageDir = path.join(storage.messageRoot, session.id);
        await storage.ensureDir(messageDir);
        for (const messageFile of messageFiles) {
          const base = path.basename(messageFile);
          await storage.moveIfExists(messageFile, path.join(messageDir, base));
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
        await storage.moveIfExists(path.join(partTrashDir, partId), path.join(storage.partRoot, partId));
      }
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }

    const diffTrashDir = path.join(sessionTrashRoot, 'session_diff');
    await storage.moveIfExists(diffTrashDir, path.join(storage.storageRoot, 'session_diff', session.id));

    const todoTrashDir = path.join(sessionTrashRoot, 'todo');
    await storage.moveIfExists(todoTrashDir, path.join(storage.storageRoot, 'todo', session.id));

    await fs.rm(sessionTrashRoot, { recursive: true, force: true });
    return { session };
  }

  async function deleteTrashItem(trashId) {
    const sessionTrashRoot = path.join(storage.trashRoot, trashId);
    await fs.rm(sessionTrashRoot, { recursive: true, force: true });
  }

  return {
    moveSessionToTrash,
    listTrashedSessions,
    restoreTrashedSession,
    deleteTrashItem
  };
}

module.exports = { createTrashService };
