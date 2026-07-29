'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { resolveAgentVendor } = require('../utils/agentVendor');
const dotenv = require('dotenv');

const ACTOR_TOKEN_KEYS = Object.freeze([
  'PALANTIR_TOKEN',
  'PALANTIR_PM_TOKEN',
]);
const MAX_ACTOR_TOKEN_FILE_BYTES = 8 * 1024;

function resolveDotEnvPath({
  env = process.env,
  cwd = process.cwd(),
} = {}) {
  const configuredPath = typeof env.DOTENV_CONFIG_PATH === 'string' && env.DOTENV_CONFIG_PATH
    ? env.DOTENV_CONFIG_PATH
    : '.env';
  return path.resolve(cwd, configuredPath);
}

function assertNoActorTokensInDotEnv({
  env = process.env,
  cwd = process.cwd(),
  fsImpl = fs,
  envPath = resolveDotEnvPath({ env, cwd }),
} = {}) {
  let raw;
  try {
    raw = fsImpl.readFileSync(envPath);
  } catch (err) {
    if (err?.code === 'ENOENT') return null;
    throw err;
  }
  const parsed = dotenv.parse(raw);
  // Windows treats process environment keys case-insensitively. Reject every
  // spelling here too so `palantir_token=...` cannot become
  // process.env.PALANTIR_TOKEN after dotenv loads it.
  const parsedKeys = new Set(Object.keys(parsed).map((key) => key.toUpperCase()));
  const exposed = ACTOR_TOKEN_KEYS.filter((key) => parsedKeys.has(key));
  if (exposed.length === 0) return null;
  const err = new Error(
    `${exposed.join(', ')} must not be stored in ${envPath}; `
    + 'use PALANTIR_ACTOR_TOKEN_FILE with a mode-0600 one-shot JSON file',
  );
  err.code = 'PALANTIR_ACTOR_TOKEN_IN_DOTENV';
  throw err;
}

function consumeActorTokenFile({
  env = process.env,
  cwd = process.cwd(),
  fsImpl = fs,
  getUid = typeof process.getuid === 'function' ? () => process.getuid() : null,
  platform = process.platform,
} = {}) {
  const rawPath = typeof env.PALANTIR_ACTOR_TOKEN_FILE === 'string'
    ? env.PALANTIR_ACTOR_TOKEN_FILE.trim()
    : '';
  if (!rawPath) return null;
  // Node's portable fs.Stat surface does not expose Windows ACLs. Treating a
  // token file as an assured boundary without checking its DACL would allow an
  // inherited group-readable ACL to masquerade as the POSIX 0600 contract.
  // Ambient/application-owned options remain available on Windows, but the
  // one-shot file transport fails closed until an ACL-aware implementation is
  // available.
  if (platform === 'win32') {
    throw new Error('PALANTIR_ACTOR_TOKEN_FILE is unsupported on Windows because its ACL cannot be verified');
  }
  const tokenPath = path.resolve(cwd, rawPath);
  const pathStat = fsImpl.lstatSync(tokenPath);
  if (!pathStat.isFile() || pathStat.isSymbolicLink()) {
    throw new Error('PALANTIR_ACTOR_TOKEN_FILE must be a regular non-symlink file');
  }

  const constants = fsImpl.constants || fs.constants;
  const openFlags = constants.O_RDONLY | (constants.O_NOFOLLOW || 0);
  let fd;
  let payload;
  let humanToken = '';
  let pmToken = '';
  try {
    fd = fsImpl.openSync(tokenPath, openFlags);
    const stat = fsImpl.fstatSync(fd);
    // O_NOFOLLOW is not available on every platform. Comparing the descriptor
    // with the pre-open lstat also closes that fallback race, and validates
    // that every subsequent check applies to the file we actually read.
    if (
      !stat.isFile()
      || (Number.isInteger(pathStat.dev) && Number.isInteger(pathStat.ino)
        && (stat.dev !== pathStat.dev || stat.ino !== pathStat.ino))
    ) {
      throw new Error('PALANTIR_ACTOR_TOKEN_FILE changed while opening');
    }
    if (stat.size <= 0 || stat.size > MAX_ACTOR_TOKEN_FILE_BYTES) {
      throw new Error(`PALANTIR_ACTOR_TOKEN_FILE must be 1..${MAX_ACTOR_TOKEN_FILE_BYTES} bytes`);
    }
    if ((stat.mode & 0o077) !== 0) {
      throw new Error('PALANTIR_ACTOR_TOKEN_FILE must have mode 0600 or stricter');
    }
    if (!Number.isInteger(stat.nlink) || stat.nlink !== 1) {
      throw new Error('PALANTIR_ACTOR_TOKEN_FILE must have exactly one hard link');
    }
    if (getUid && Number.isInteger(stat.uid) && stat.uid !== getUid()) {
      throw new Error('PALANTIR_ACTOR_TOKEN_FILE must be owned by the Console user');
    }
    payload = JSON.parse(fsImpl.readFileSync(fd, 'utf8'));

    // Do not unlink a replacement path if another account can rename entries
    // in the containing directory. A mismatch fails boot; the validated
    // descriptor is never confused with attacker-selected bytes.
    const unlinkStat = fsImpl.lstatSync(tokenPath);
    if (
      Number.isInteger(stat.dev) && Number.isInteger(stat.ino)
      && (unlinkStat.dev !== stat.dev || unlinkStat.ino !== stat.ino)
    ) {
      throw new Error('PALANTIR_ACTOR_TOKEN_FILE changed before unlink');
    }

    humanToken = payload && typeof payload.PALANTIR_TOKEN === 'string'
      ? payload.PALANTIR_TOKEN
      : '';
    pmToken = payload && typeof payload.PALANTIR_PM_TOKEN === 'string'
      ? payload.PALANTIR_PM_TOKEN
      : '';
    if (!humanToken) {
      throw new Error('PALANTIR_ACTOR_TOKEN_FILE requires a non-empty PALANTIR_TOKEN');
    }
    if (pmToken && pmToken === humanToken) {
      throw new Error('PALANTIR_PM_TOKEN must differ from PALANTIR_TOKEN');
    }

    // Unlink while the validated descriptor is still open, then prove that
    // descriptor's inode actually lost its final link. A same-UID process may
    // rename the original and swap a replacement into tokenPath between the
    // lstat above and unlinkSync; checking only the pathname would then delete
    // the replacement and leave the secret under its new name.
    fsImpl.unlinkSync(tokenPath);
    const unlinkedStat = fsImpl.fstatSync(fd);
    if (!Number.isInteger(unlinkedStat.nlink) || unlinkedStat.nlink !== 0) {
      throw new Error('PALANTIR_ACTOR_TOKEN_FILE validated file was not unlinked');
    }
  } catch (err) {
    if (err?.code === 'ELOOP') {
      throw new Error('PALANTIR_ACTOR_TOKEN_FILE must be a regular non-symlink file');
    }
    if (/^PALANTIR_ACTOR_TOKEN_FILE /.test(err?.message || '')) throw err;
    throw new Error(`PALANTIR_ACTOR_TOKEN_FILE must contain valid JSON: ${err.message}`);
  } finally {
    if (fd !== undefined) fsImpl.closeSync(fd);
  }

  // Never publish these globals into process.env: same-UID local agents may
  // be able to inspect the Console environment.
  for (const key of Object.keys(env)) {
    const normalized = key.toUpperCase();
    if (normalized === 'PALANTIR_TOKEN' || normalized === 'PALANTIR_PM_TOKEN') {
      delete env[key];
    }
  }
  delete env.PALANTIR_ACTOR_TOKEN_FILE;
  return {
    source: 'ephemeral_file',
    tokenPath,
    authToken: humanToken,
    pmToken: pmToken || null,
  };
}

function prepareActorTokenEnvironment(options = {}) {
  const env = options.env || process.env;
  // Test/isolated boot explicitly opts out of dotenv as a whole. Honor that
  // before inspection too; an ignored developer .env must not abort Playwright.
  // An explicitly supplied one-shot token file is still consumed below.
  if (!env.PALANTIR_SKIP_DOTENV) assertNoActorTokensInDotEnv(options);
  return consumeActorTokenFile(options);
}

// Human browser mutations use PALANTIR_TOKEN through an HttpOnly cookie.
// Manager/Operator and Worker processes never receive either global token:
// they get boot-local, run-bound capabilities instead. PALANTIR_PM_TOKEN is
// retained for external bearer automation compatibility. The agent boundary
// is verified only when boot consumed an ephemeral token file (or an embedder
// supplied application-owned options); direct env is marked unverified.
//
// Run capabilities are a second, independent boundary. A same-UID process can
// inspect another process's environment on supported hosts, so no manager or
// worker capability may be minted unless the deployer has placed agents behind
// a real OS-user/container boundary and explicitly attested that fact.

function resolveActorTokenPolicy(env = process.env) {
  const humanToken = typeof env.PALANTIR_TOKEN === 'string' && env.PALANTIR_TOKEN
    ? env.PALANTIR_TOKEN
    : null;
  const pmToken = typeof env.PALANTIR_PM_TOKEN === 'string' && env.PALANTIR_PM_TOKEN
    ? env.PALANTIR_PM_TOKEN
    : null;
  const separated = !!(humanToken && pmToken && humanToken !== pmToken);
  const source = env.PALANTIR_ACTOR_TOKEN_SOURCE;
  const sourceAssured = source === 'ephemeral_file' || source === 'application_options';
  const processIsolated = env.PALANTIR_AGENT_PROCESS_ISOLATION === 'verified';
  const capabilitiesEnabled = !!(humanToken && processIsolated);
  return {
    humanToken,
    agentToken: separated ? pmToken : humanToken,
    separated,
    processIsolated,
    capabilitiesEnabled,
    boundary: humanToken
      ? (
        capabilitiesEnabled
          ? (sourceAssured ? 'run_capabilities' : 'run_capabilities_unverified')
          : 'agent_capabilities_disabled'
      )
      : 'auth_disabled',
  };
}

function isResolvedActorTokenPolicy(value) {
  return !!(value
    && typeof value === 'object'
    && typeof value.boundary === 'string'
    && Object.prototype.hasOwnProperty.call(value, 'agentToken')
    && Object.prototype.hasOwnProperty.call(value, 'humanToken'));
}

function actorTokenPolicyFrom(source) {
  return isResolvedActorTokenPolicy(source)
    ? source
    : resolveActorTokenPolicy(source || process.env);
}

function isActorCredentialKey(key) {
  if (typeof key !== 'string') return false;
  const normalized = key.toUpperCase();
  return normalized === 'PALANTIR_TOKEN'
    || normalized === 'PALANTIR_PM_TOKEN'
    || normalized === 'PALANTIR_WORKER_TOKEN'
    || normalized === 'PALANTIR_MANAGER_TOKEN';
}

function isWorkerApiBaseKey(key) {
  return typeof key === 'string' && key.toUpperCase() === 'PALANTIR_API_BASE';
}

function stripActorCredentials(env) {
  for (const key of Object.keys(env)) {
    if (isActorCredentialKey(key)) delete env[key];
  }
  return env;
}

// Worker and manager profiles explicitly choose additional variables through
// agent_profiles.env_allowlist. This shared process baseline is intentionally
// narrow; merging all of process.env at either engine boundary would silently
// bypass that allowlist.
//
// HOME, APPDATA, and LOCALAPPDATA are credential/config locators rather than
// merely non-secret runtime variables: Claude and Codex use them to find stores
// such as ~/.claude and ~/.codex. They remain here because both CLIs require
// their normal home/config location to operate.
const PROCESS_BASE_ENV_KEYS = Object.freeze([
  'PATH',
  'Path',
  'HOME',
  'USERPROFILE',
  'HOMEDRIVE',
  'HOMEPATH',
  'USER',
  'USERNAME',
  'LOGNAME',
  'SHELL',
  // Windows subprocesses need these runtime variables to resolve .cmd shims
  // and start the command shell. APPDATA and LOCALAPPDATA also deliberately
  // locate CLI configuration and credential stores.
  'SystemRoot',
  'SYSTEMROOT',
  'WINDIR',
  'ComSpec',
  'COMSPEC',
  'PATHEXT',
  'APPDATA',
  'LOCALAPPDATA',
  'PROGRAMDATA',
  'TMPDIR',
  'TEMP',
  'TMP',
  'LANG',
  'LANGUAGE',
  'LC_ALL',
  'LC_CTYPE',
  'TERM',
  'COLORTERM',
  'NO_COLOR',
  'FORCE_COLOR',
]);

// Workers and managers each derive their own set from the common baseline.
// This is a distinct array, not an alias: a future worker-only key is appended
// HERE, so it cannot flow into managers. Managers likewise extend the shared
// baseline in MANAGER_BASE_ENV_KEYS below and never read this set. Deriving one
// from the other in either direction would make the more privileged surface
// grow silently whenever the other one does.
const WORKER_BASE_ENV_KEYS = Object.freeze([...PROCESS_BASE_ENV_KEYS]);

// Proxy URLs can contain credentials (for example,
// http://user:password@proxy:3128), so these are not part of the nominal
// process baseline. They are forwarded as a separate, explicit compatibility
// set for corporate networks. buildManagerSpawnEnv emits a value-free security
// diagnostic when a forwarded proxy URL contains userinfo.
const NETWORK_ENV_KEYS = Object.freeze([
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'ALL_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'all_proxy',
  'no_proxy',
]);

const VENDOR_ENV_KEYS = Object.freeze({
  claude: Object.freeze([
    'NODE_EXTRA_CA_CERTS',
    'CLAUDE_CONFIG_DIR',
  ]),
  codex: Object.freeze([
    'CODEX_HOME',
    'CODEX_CA_CERTIFICATE',
    'SSL_CERT_FILE',
  ]),
});

function MANAGER_BASE_ENV_KEYS(vendor) {
  const normalizedVendor = resolveAgentVendor(vendor);
  return [
    ...PROCESS_BASE_ENV_KEYS,
    ...NETWORK_ENV_KEYS,
    ...(VENDOR_ENV_KEYS[normalizedVendor] || []),
  ];
}

function buildWorkerProcessEnv(baseEnv = process.env, explicitEnv = {}, policySource = baseEnv) {
  // Keep the policy parameter in the public seam: callers pass the app-scoped
  // policy here even though workers are denied both global actor credentials
  // regardless of boundary mode.
  actorTokenPolicyFrom(policySource);
  const merged = {};
  for (const key of WORKER_BASE_ENV_KEYS) {
    if (baseEnv && baseEnv[key] != null) merged[key] = baseEnv[key];
  }
  Object.assign(merged, explicitEnv || {});
  // Windows environment keys are case-insensitive. Scrub every spelling so a
  // lower-case profile entry cannot reintroduce a global actor credential.
  stripActorCredentials(merged);
  if (
    explicitEnv
    && typeof explicitEnv.PALANTIR_WORKER_TOKEN === 'string'
    && explicitEnv.PALANTIR_WORKER_TOKEN
  ) {
    merged.PALANTIR_WORKER_TOKEN = explicitEnv.PALANTIR_WORKER_TOKEN;
  }
  return merged;
}

/**
 * Prefix PATH without creating case-variant duplicates.
 *
 * Windows commonly exposes the inherited key as `Path`; adding a second
 * `PATH` key makes child_process selection ambiguous and can discard the real
 * executable search path. Keep the casing of the first non-empty inherited
 * variant and remove every duplicate spelling before returning.
 */
function augmentProcessPath(explicitEnv = {}, prefixes = [], {
  delimiter = path.delimiter,
} = {}) {
  const env = { ...(explicitEnv || {}) };
  const pathKeys = Object.keys(env).filter((key) => key.toUpperCase() === 'PATH');
  const selectedKey = pathKeys.find((key) => typeof env[key] === 'string' && env[key])
    || pathKeys[0]
    || 'PATH';
  const currentPath = typeof env[selectedKey] === 'string' ? env[selectedKey] : '';
  for (const key of pathKeys) {
    if (key !== selectedKey) delete env[key];
  }
  const additions = Array.isArray(prefixes)
    ? prefixes.filter((value) => typeof value === 'string' && value)
    : [];
  env[selectedKey] = [...additions, currentPath].filter(Boolean).join(delimiter);
  return env;
}

// Managers receive only a boot-local, run-bound capability in their process
// environment. The value is deliberately absent from argv and the persisted
// system-prompt file; the prompt references the variable name only. Neither
// global human nor external PM bearer credentials crosses this seam.
function applyManagerCredentialPolicy(explicitEnv = {}, {
  managerToken = null,
  actorTokens = null,
} = {}) {
  const env = stripActorCredentials({ ...(explicitEnv || {}) });
  if (typeof managerToken === 'string' && managerToken) {
    if (!actorTokenPolicyFrom(actorTokens).capabilitiesEnabled) {
      throw new Error('manager capability requires verified agent process isolation');
    }
    env.PALANTIR_MANAGER_TOKEN = managerToken;
  }
  return env;
}

function normalizeWorkerApiBase(apiBase) {
  if (apiBase === undefined || apiBase === null || apiBase === '') return null;
  if (typeof apiBase !== 'string' || /[\r\n\x00]/.test(apiBase)) {
    const err = new Error('PALANTIR_API_BASE must be a non-empty single-line URL');
    err.code = 'WORKER_API_BASE_INVALID';
    throw err;
  }
  const normalized = apiBase.trim().replace(/\/+$/, '');
  let parsed;
  try {
    parsed = new URL(normalized);
  } catch {
    const err = new Error('PALANTIR_API_BASE must be a valid URL');
    err.code = 'WORKER_API_BASE_INVALID';
    throw err;
  }
  if (parsed.username || parsed.password) {
    const err = new Error('PALANTIR_API_BASE must not contain URL userinfo');
    err.code = 'WORKER_API_BASE_USERINFO';
    throw err;
  }
  return normalized;
}

function applyWorkerCredentialPolicy(explicitEnv = {}, {
  workerToken = null,
  apiBase = null,
  actorTokens = null,
} = {}) {
  const merged = stripActorCredentials({ ...(explicitEnv || {}) });
  // Drop profile-provided values first; only the server-selected apiBase may
  // reintroduce this address.
  for (const key of Object.keys(merged)) {
    if (isWorkerApiBaseKey(key)) delete merged[key];
  }
  const hasWorkerToken = typeof workerToken === 'string' && !!workerToken;
  if (hasWorkerToken) {
    if (!actorTokenPolicyFrom(actorTokens).capabilitiesEnabled) {
      throw new Error('worker capability requires verified agent process isolation');
    }
    merged.PALANTIR_WORKER_TOKEN = workerToken;
  }
  // Enforced HERE, not left to callers. The endpoint is only useful with a
  // capability to present at it, and this function's name says it is where the
  // worker credential policy lives — a caller that trusts it without adding its
  // own gate would otherwise ship the address alone. The existing callers do
  // gate, so this changes nothing today; it means a future one cannot forget.
  const normalizedApiBase = hasWorkerToken ? normalizeWorkerApiBase(apiBase) : null;
  if (normalizedApiBase) merged.PALANTIR_API_BASE = normalizedApiBase;
  return merged;
}

function createWorkerProposalTokenService({
  actorTokens = resolveActorTokenPolicy(),
  signingKey: injectedSigningKey = null,
} = {}) {
  const policy = actorTokenPolicyFrom(actorTokens);
  // This key is deliberately independent from every human/manager credential.
  // A worker sees known claims plus its HMAC, so deriving the key from a
  // user-chosen bearer token would create an offline token-guessing oracle.
  // Boot-local randomness also revokes outstanding worker capabilities on
  // restart, matching the lifecycle restart fence.
  const signingKey = policy.capabilitiesEnabled
    ? (injectedSigningKey || crypto.randomBytes(32))
    : null;

  function mint(runId, { projectId = null } = {}) {
    if (!signingKey) return null;
    const id = typeof runId === 'string' ? runId : '';
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(id)) {
      throw new Error('worker proposal token requires a valid run id');
    }
    const project = projectId == null ? null : String(projectId);
    if (project != null && !/^[A-Za-z0-9_-]{1,128}$/.test(project)) {
      throw new Error('worker proposal token requires a valid project id');
    }
    const encoded = Buffer.from(JSON.stringify({
      runId: id,
      projectId: project,
    }), 'utf8').toString('base64url');
    const signature = crypto
      .createHmac('sha256', signingKey)
      .update(`v2\0${encoded}`)
      .digest('base64url');
    return `palw2.${encoded}.${signature}`;
  }

  function verify(token) {
    if (!signingKey || typeof token !== 'string') return null;
    const parts = token.split('.');
    if (parts.length !== 3 || parts[0] !== 'palw2') return null;
    let claims;
    try {
      claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    } catch {
      return null;
    }
    const runId = claims && typeof claims === 'object' && !Array.isArray(claims)
      ? claims.runId
      : null;
    const projectId = claims && Object.hasOwn(claims, 'projectId')
      ? claims.projectId
      : null;
    if (
      !/^[A-Za-z0-9_-]{1,128}$/.test(runId)
      || (projectId != null && (
        typeof projectId !== 'string'
        || !/^[A-Za-z0-9_-]{1,128}$/.test(projectId)
      ))
      || Buffer.from(JSON.stringify({ runId, projectId }), 'utf8').toString('base64url') !== parts[1]
    ) {
      return null;
    }
    const expected = crypto
      .createHmac('sha256', signingKey)
      .update(`v2\0${parts[1]}`)
      .digest();
    let presented;
    try { presented = Buffer.from(parts[2], 'base64url'); } catch { return null; }
    if (presented.length !== expected.length || !crypto.timingSafeEqual(presented, expected)) {
      return null;
    }
    return { runId, projectId };
  }

  return { mint, verify };
}

function createManagerCapabilityTokenService({
  actorTokens = resolveActorTokenPolicy(),
  signingKey: injectedSigningKey = null,
} = {}) {
  const policy = actorTokenPolicyFrom(actorTokens);
  const signingKey = policy.capabilitiesEnabled
    ? (injectedSigningKey || crypto.randomBytes(32))
    : null;

  function mint(runId, {
    conversationId,
    layer,
  } = {}) {
    if (!signingKey) return null;
    const id = typeof runId === 'string' ? runId : '';
    const conversation = typeof conversationId === 'string' ? conversationId : '';
    const managerLayer = typeof layer === 'string' ? layer : '';
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(id)) {
      throw new Error('manager capability requires a valid run id');
    }
    if (
      conversation !== 'top'
      && !/^operator:[A-Za-z0-9_-]{1,128}$/.test(conversation)
    ) {
      throw new Error('manager capability requires a valid conversation id');
    }
    if (managerLayer !== 'top' && managerLayer !== 'operator' && managerLayer !== 'pm') {
      throw new Error('manager capability requires a valid layer');
    }
    const encoded = Buffer.from(JSON.stringify({
      runId: id,
      conversationId: conversation,
      layer: managerLayer,
    }), 'utf8').toString('base64url');
    const signature = crypto
      .createHmac('sha256', signingKey)
      .update(`manager-v1\0${encoded}`)
      .digest('base64url');
    return `palm1.${encoded}.${signature}`;
  }

  function verify(token) {
    if (!signingKey || typeof token !== 'string') return null;
    const parts = token.split('.');
    if (parts.length !== 3 || parts[0] !== 'palm1') return null;
    let claims;
    try {
      claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    } catch {
      return null;
    }
    const runId = claims && typeof claims === 'object' && !Array.isArray(claims)
      ? claims.runId
      : null;
    const conversationId = claims && typeof claims === 'object'
      ? claims.conversationId
      : null;
    const layer = claims && typeof claims === 'object' ? claims.layer : null;
    if (
      typeof runId !== 'string'
      || !/^[A-Za-z0-9_-]{1,128}$/.test(runId)
      || (
        conversationId !== 'top'
        && !/^operator:[A-Za-z0-9_-]{1,128}$/.test(conversationId)
      )
      || !['top', 'operator', 'pm'].includes(layer)
      || Buffer.from(JSON.stringify({ runId, conversationId, layer }), 'utf8').toString('base64url') !== parts[1]
    ) {
      return null;
    }
    const expected = crypto
      .createHmac('sha256', signingKey)
      .update(`manager-v1\0${parts[1]}`)
      .digest();
    let presented;
    try { presented = Buffer.from(parts[2], 'base64url'); } catch { return null; }
    if (presented.length !== expected.length || !crypto.timingSafeEqual(presented, expected)) {
      return null;
    }
    return { runId, conversationId, layer };
  }

  return { mint, verify };
}

module.exports = {
  ACTOR_TOKEN_KEYS,
  resolveDotEnvPath,
  assertNoActorTokensInDotEnv,
  consumeActorTokenFile,
  prepareActorTokenEnvironment,
  resolveActorTokenPolicy,
  isActorCredentialKey,
  isWorkerApiBaseKey,
  PROCESS_BASE_ENV_KEYS,
  WORKER_BASE_ENV_KEYS,
  NETWORK_ENV_KEYS,
  VENDOR_ENV_KEYS,
  MANAGER_BASE_ENV_KEYS,
  buildWorkerProcessEnv,
  augmentProcessPath,
  applyManagerCredentialPolicy,
  normalizeWorkerApiBase,
  applyWorkerCredentialPolicy,
  createWorkerProposalTokenService,
  createManagerCapabilityTokenService,
};
