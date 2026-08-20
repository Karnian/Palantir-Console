'use strict';

const fs = require('node:fs');

function readExecEnviron({
  platform = process.platform,
  readFile = fs.readFileSync,
} = {}) {
  if (platform !== 'linux') {
    return { readable: false, content: null, reason: 'unsupported_platform' };
  }
  try {
    return {
      readable: true,
      content: String(readFile('/proc/self/environ')),
      reason: 'proc_self_environ',
    };
  } catch (_err) {
    return { readable: false, content: null, reason: 'environ_unreadable' };
  }
}

function attestHumanTokenAbsent(humanToken, {
  readExecEnviron: readEnviron = readExecEnviron,
} = {}) {
  if (!humanToken) return { verified: true, reason: 'no_human_token' };

  try {
    const environ = readEnviron();
    if (!environ || !environ.readable) {
      return {
        verified: false,
        reason: environ && typeof environ.reason === 'string'
          ? environ.reason
          : 'environ_unreadable',
      };
    }
    if (typeof environ.content === 'string' && environ.content.includes(humanToken)) {
      return { verified: false, reason: 'token_in_exec_environ' };
    }
    return { verified: true, reason: 'absent_from_exec_environ' };
  } catch (_err) {
    return { verified: false, reason: 'environ_unreadable' };
  }
}

module.exports = {
  readExecEnviron,
  attestHumanTokenAbsent,
};
