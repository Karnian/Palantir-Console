'use strict';
const path = require('node:path');
const { baseKeys } = require('./spawnEnv');
const inheritedKeys = Object.freeze(baseKeys.filter(key => key !== 'HOME'));
const failure = code => Object.assign(new Error(code), { code });
const quote = value => "'" + value.replace(/'/g, "'\\''") + "'";
function buildHandoffCommand({ cwd, home, executablePath, claudeSessionId }) {
  for (const value of [cwd, home, executablePath]) {
    if (typeof value === 'string' && value.includes('\\')) throw failure('unsupported_path_character');
    if (typeof value !== 'string' || !path.isAbsolute(value) || /[\0\r\n]/.test(value)) {
      throw failure('invalid_handoff_path');
    }
  }
  if (typeof claudeSessionId !== 'string' || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(claudeSessionId)) {
    throw failure('invalid_claude_session_id');
  }
  // sh can create unexported SHELL/TERM defaults. Preserve only inherited exported values.
  const inherited = `for key in ${inheritedKeys.join(' ')}; do ` +
    '/usr/bin/printenv "$key" >/dev/null || unset "$key"; done; ';
  const command = inherited + `cd ${quote(cwd)} && /usr/bin/env -i ${inheritedKeys.map(name => '${' + name + '+"' + name + '=$' + name + '"}').join(' ')} ` +
    `HOME=${quote(home)} ${quote(executablePath)} --resume ${quote(claudeSessionId)}`;
  return `/bin/sh -c ${quote(command)}`;
}
module.exports = { buildHandoffCommand, inheritedKeys };
