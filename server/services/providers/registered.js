/**
 * Reads the opencode auth.json file to discover which provider keys the user
 * has configured. The file lives at `~/.local/share/opencode/auth.json` by
 * default and contains an object whose top-level keys are provider ids
 * (e.g. `openai`, `anthropic`, `google`).
 *
 * This is the only place that knows about the opencode auth file shape.
 */

const fs = require('fs/promises');

async function listRegisteredProviders(authPath) {
  if (!authPath) return [];
  let data;
  try {
    data = await fs.readFile(authPath, 'utf8');
  } catch {
    return [];
  }
  let parsed;
  try {
    parsed = JSON.parse(data);
  } catch {
    return [];
  }
  if (!parsed || typeof parsed !== 'object') return [];
  return Object.keys(parsed).sort();
}

module.exports = { listRegisteredProviders };
