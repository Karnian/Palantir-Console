'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { resolveClaudeBinary } = require('./streamJsonEngine');

function managedSettingsPresent(paths, filesystem = fs) {
  function hasFile(filename) {
    try {
      const stat = filesystem.lstatSync(filename);
      if (!stat.isDirectory()) return true;
      return filesystem.readdirSync(filename).some(name => hasFile(path.join(filename, name)));
    } catch (error) {
      // Unknown permissions cannot prove managed hooks are absent.
      return error.code !== 'ENOENT' && error.code !== 'ENOTDIR';
    }
  }
  return paths.some(hasFile);
}

function sessionHubActive({ env = process.env, observeState, authToken, managedPaths,
  filesystem = fs, resolveBinary = resolveClaudeBinary, user } = {}) {
  if (env.PALANTIR_SESSION_HUB !== '1' || !observeState.on || !authToken) return false;
  if (!resolveBinary().executable) return false;
  if (!managedPaths) {
    try { user ??= os.userInfo().username; } catch { return false; }
    managedPaths = [
      '/Library/Application Support/ClaudeCode/',
      '/Library/Managed Preferences/com.anthropic.claudecode.plist',
      `/Library/Managed Preferences/${user}/com.anthropic.claudecode.plist`,
      '/etc/claude-code/',
    ];
  }
  return !managedSettingsPresent(managedPaths, filesystem);
}

module.exports = { sessionHubActive, managedSettingsPresent };
