'use strict';
const path = require('node:path');
const pin = require('./pin');
const unsetEnv = Object.freeze([...new Set([...pin.forbiddenAuthEnv,
  'CLAUDE_CONFIG_DIR', 'CLAUDE_SECURESTORAGE_CONFIG_DIR'])]);
const failure = code => Object.assign(new Error(code), { code });
const quote = value => "'" + value.replace(/'/g, "'\\''") + "'";
function buildHandoffCommand({ cwd, home, executablePath, claudeSessionId }) {
  for (const value of [cwd, home, executablePath]) {
    if (typeof value !== 'string' || !path.isAbsolute(value) || /[\0\r\n]/.test(value)) {
      throw failure('invalid_handoff_path');
    }
  }
  if (typeof claudeSessionId !== 'string' || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(claudeSessionId)) {
    throw failure('invalid_claude_session_id');
  }
  return `cd ${quote(cwd)} && env ${unsetEnv.map(name => `-u ${quote(name)}`).join(' ')} ` +
    `HOME=${quote(home)} ${quote(executablePath)} --resume ${quote(claudeSessionId)}`;
}
module.exports = { buildHandoffCommand, unsetEnv };
