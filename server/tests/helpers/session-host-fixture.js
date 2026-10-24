'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHostCore } = require('../../sessionHost/core');
const { createFakeAdapter } = require('../../sessionHost/fakeAdapter');
const { createFakeIdentityProbe } = require('../../sessionHost/identity');
const { createFaults } = require('../../sessionHost/faults');
function fixture(t, options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sh1-'));
  const dbPath = path.join(dir, 'host.sqlite');
  let time = 1800000000000, n = 0, boot = 0;
  const probe = createFakeIdentityProbe(), faults = createFaults();
  const adapter = createFakeAdapter({ identityProbe: probe, ...options });
  let core;
  const f = {
    dir, dbPath, probe, faults, adapter,
    get core() { return core; },
    get time() { return time; },
    advance(ms) { time += ms; },
    key(at = time) { return `rk_${at}_${(++n).toString(16).padStart(16, '0')}`; },
    req(kind, extra = {}) { return { request_key: f.key(), kind, session_id: f.sid, incarnation_id: f.iid, ...extra }; },
    start() { const c = core.submit({ request_key: f.key(), kind: 'start', cwd: '/private/work' }); f.sid = c.session_id; f.iid = c.incarnation_id; return c; },
    prompt(body = 'hello') { return core.submit(f.req('prompt', { body })); },
    state() { return core.snapshot(f.sid).state; },
    d(id) { return f.state().deliveries.find(d => d.id === id); },
    reboot() { core?.close(); core = createHostCore({ dbPath, adapter, identityProbe: probe, faults, clock: () => time, hostBootId: `boot-${++boot}` }); return core; }
  };
  f.reboot();
  t.after(() => { core.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return f;
}
module.exports = { fixture };
