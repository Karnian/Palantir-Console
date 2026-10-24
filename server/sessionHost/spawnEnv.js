'use strict';
const pin = require('./pin');
const baseKeys = Object.freeze(['PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TMPDIR', 'TERM']);
const sdkKeys = Object.freeze(['CLAUDE_AGENT_SDK_VERSION', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_SDK_READS_SESSION_STATE']);
const marker = 'PALANTIR_OWNED_INCARNATION';
function validId(id) {
  return typeof id === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id);
}
function fail() {
  throw Object.assign(new Error('invalid_child_env'), { code: 'invalid_child_env' });
}
function assertChildEnv(env, incarnationId) {
  if (!validId(incarnationId) || !env || typeof env !== 'object' || Array.isArray(env)) fail();
  if (Object.getPrototypeOf(env) !== null) fail();
  if (!Object.hasOwn(env, marker) || env[marker] !== incarnationId) fail();
  if (Reflect.ownKeys(env).some(key => typeof key !== 'string')) fail();
  for (const key in env) {
    if (key.includes('=') || /[\0\r\n]/.test(key)) fail();
    const value = env[key];
    if (typeof value !== 'string' || value.includes('\0') || value.startsWith('sk-ant-')) fail();
    if (pin.forbiddenAuthEnv.includes(key) || (key.startsWith('PALANTIR_') && key !== marker)) fail();
  }
  return true;
}
function buildChildEnv({ baseEnv = {}, sdkEnv = {}, incarnationId }) {
  if (!validId(incarnationId)) fail();
  const env = Object.create(null);
  for (const [source, keys] of [[baseEnv, baseKeys], [sdkEnv, sdkKeys]]) {
    for (const key of keys) if (Object.hasOwn(source, key)) env[key] = source[key];
  }
  env[marker] = incarnationId;
  assertChildEnv(env, incarnationId);
  return env;
}
module.exports = { buildChildEnv, assertChildEnv, validId };
