'use strict';
const path = require('node:path');
const { baseKeys } = require('./spawnEnv');
const inheritedKeys = Object.freeze(baseKeys.filter(key => key !== 'HOME'));
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
  return `cd ${quote(cwd)} && env -i ${inheritedKeys.map(name => '${' + name + '+"' + name + '=$' + name + '"}').join(' ')} ` +
    `HOME=${quote(home)} ${quote(executablePath)} --resume ${quote(claudeSessionId)}`;
}
module.exports = { buildHandoffCommand, inheritedKeys };
