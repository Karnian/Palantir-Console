'use strict';

async function reapProcessGroup(pgid, { kill = process.kill, termMs = 5000, reapMs = 10000, pollMs = 25 } = {}) {
  if (!pgid) return;
  const signal = name => {
    try { kill(-pgid, name); }
    catch (err) { if (err.code !== 'ESRCH' && err.code !== 'EPERM') throw err; }
  };
  const alive = () => {
    try { kill(-pgid, 0); return true; }
    catch (err) {
      if (err.code === 'ESRCH') return false;
      if (err.code === 'EPERM') return true;
      throw err;
    }
  };
  const begun = Date.now();
  signal('SIGTERM');
  let escalated = false;
  while (alive()) {
    if (Date.now() - begun >= reapMs) throw Object.assign(new Error('reap_failed'), { code: 'reap_failed' });
    if (!escalated && Date.now() - begun >= termMs) { signal('SIGKILL'); escalated = true; }
    await new Promise(resolve => setTimeout(resolve, pollMs));
  }
}

module.exports = { reapProcessGroup };
