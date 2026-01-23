const path = require('path');
const os = require('os');
const fs = require('fs/promises');
const fg = require('fast-glob');

function createStorageContext(options = {}) {
  const storageRoot = options.storageRoot
    || process.env.OPENCODE_STORAGE
    || path.join(os.homedir(), '.local', 'share', 'opencode', 'storage');
  const fsRoot = options.fsRoot || process.env.OPENCODE_FS_ROOT || os.homedir();
  const sessionRoot = path.join(storageRoot, 'session');
  const messageRoot = path.join(storageRoot, 'message');
  const partRoot = path.join(storageRoot, 'part');
  const trashRoot = path.join(storageRoot, 'trash', 'sessions');

  async function readJson(filePath) {
    const raw = await fs.readFile(filePath, 'utf8');
    return JSON.parse(raw);
  }

  async function writeJson(filePath, data) {
    const raw = JSON.stringify(data, null, 2);
    await fs.writeFile(filePath, `${raw}\n`, 'utf8');
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

  async function listSessionFiles() {
    return fg('**/ses_*.json', { cwd: sessionRoot, absolute: true, onlyFiles: true });
  }

  async function findSessionFile(sessionId) {
    const files = await fg(`**/${sessionId}.json`, { cwd: sessionRoot, absolute: true, onlyFiles: true });
    return files[0] || null;
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

  return {
    storageRoot,
    fsRoot,
    sessionRoot,
    messageRoot,
    partRoot,
    trashRoot,
    readJson,
    writeJson,
    ensureDir,
    moveIfExists,
    listSessionFiles,
    findSessionFile,
    getMessageMetas,
    loadMessageParts
  };
}

module.exports = { createStorageContext };
