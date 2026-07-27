'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
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
  let ambientActorTokens = false;
  for (const key of Object.keys(env)) {
    const normalized = key.toUpperCase();
    if (normalized === 'PALANTIR_TOKEN' || normalized === 'PALANTIR_PM_TOKEN') {
      // An empty value is not a usable credential, so it is nothing for a
      // sibling to recover. Launchers routinely declare optional secrets as
      // empty; treating that as taint would disable capabilities for a
      // perfectly safe bootstrap.
      if (typeof env[key] === 'string' && env[key] !== '') ambientActorTokens = true;
      delete env[key];
    }
  }
  delete env.PALANTIR_ACTOR_TOKEN_FILE;
  return {
    // Deleting a key from `process.env` does NOT rewrite the process image that
    // `/proc/<pid>/environ` exposes on Linux — that reflects the environment as
    // it was at exec. So a deployment that sets PALANTIR_TOKEN in the
    // environment AND passes a token file (the obvious way to migrate) leaves
    // the original token recoverable by exactly the same-UID sibling this
    // bootstrap exists to defend against.
    //
    // Such a boot is reported as tainted rather than assured. Auth still works;
    // only the attenuated capability grade, whose whole premise is that the
    // human token is unrecoverable, is withheld.
    source: ambientActorTokens ? 'ephemeral_file_tainted' : 'ephemeral_file',
    ambientActorTokens,
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
// Run capabilities are a second, independent boundary. PALANTIR_AGENT_PROCESS_ISOLATION
// may claim sibling confidentiality only when it is explicitly `verified`.
// Without that claim, a same-UID sibling may be able to read a manager's
// environment (subject to the host's ptrace/dumpable/LSM or code-signing
// controls). We therefore describe the default honestly as attenuated, not
// isolated: a stolen capability still cannot cross the human cookie boundary,
// is restricted to a small orchestration allowlist, expires, and is audited.

// #436: whether an actor token was in THIS process's environment, captured at
// module load — the earliest point this file can observe. `/proc/<pid>/environ`
// reports the environment as it was at exec, so a token that was ever there
// stays recoverable by a same-UID sibling however thoroughly it is deleted
// afterwards. A check that reads `process.env` later is defeated by simply
// deleting the variable first, which is exactly what a careful embedder does:
//
//   const token = process.env.PALANTIR_TOKEN;
//   delete process.env.PALANTIR_TOKEN;
//   createApp({ authToken: token });      // looks clean, is not
//
// Keys are matched case-insensitively because the environment is not.
function scanAmbientActorTokens(env) {
  for (const key of Object.keys(env || {})) {
    const normalized = key.toUpperCase();
    if (normalized !== 'PALANTIR_TOKEN' && normalized !== 'PALANTIR_PM_TOKEN') continue;
    // An empty value is not a usable credential and so is nothing to recover.
    if (typeof env[key] === 'string' && env[key] !== '') return true;
  }
  return false;
}

const AMBIENT_ACTOR_TOKENS_AT_LOAD = scanAmbientActorTokens(process.env);

function hadAmbientActorTokensAtLoad() {
  return AMBIENT_ACTOR_TOKENS_AT_LOAD;
}

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
  // A security kill switch must not fail open on a typo: anything other than
  // the two known values aborts rather than silently granting capabilities.
  const rawCapabilities = env.PALANTIR_AGENT_CAPABILITIES;
  if (rawCapabilities !== undefined && rawCapabilities !== ''
      && rawCapabilities !== 'disabled' && rawCapabilities !== 'enabled') {
    const err = new Error(
      `PALANTIR_AGENT_CAPABILITIES must be 'disabled' or 'enabled' (got ${JSON.stringify(rawCapabilities)})`);
    err.code = 'PALANTIR_AGENT_CAPABILITIES_INVALID';
    throw err;
  }
  const capabilitiesForcedDisabled = rawCapabilities === 'disabled';
  // #436: the `shared_uid_attenuated` grade was designed, reviewed across eight
  // adversarial rounds, and withdrawn. Making a COPYABLE credential safe needs
  // an ownership model this codebase does not have — per-grant ownership on
  // every run, event and output; no vendor resume handles in event payloads
  // (four producers write them); exec-time proof that the human token was never
  // in this process's environment; and a cost budget that bounds a copied token
  // without denying the real manager. `isolated` needs none of that, because
  // there the credential is not copyable in the first place.
  //
  // So the grade stays binary. What survived that work — the allowlist being
  // DERIVED from the isolated rules, the conversation direction rule, the
  // manager-run intervention guard, the audit — applies to `isolated` and is
  // kept. See the attenuated-grade issue before reintroducing a middle grade.
  const capabilityTier = !humanToken || capabilitiesForcedDisabled || !processIsolated
    ? 'disabled'
    : 'isolated';
  const capabilitiesEnabled = capabilityTier !== 'disabled';
  return {
    humanToken,
    agentToken: separated ? pmToken : humanToken,
    separated,
    processIsolated,
    capabilitiesForcedDisabled,
    capabilityTier,
    capabilitiesEnabled,
    boundary: humanToken
      ? (
        capabilityTier === 'isolated'
          ? (sourceAssured ? 'run_capabilities' : 'run_capabilities_unverified')
          : (
            capabilityTier === 'shared_uid_attenuated'
              ? 'shared_uid_attenuated'
              : 'agent_capabilities_disabled'
          )
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

function stripActorCredentials(env) {
  for (const key of Object.keys(env)) {
    if (isActorCredentialKey(key)) delete env[key];
  }
  return env;
}

// Worker profiles explicitly choose credential-bearing variables through
// agent_profiles.env_allowlist. Only a small, non-secret process baseline may
// cross the final engine boundary implicitly; merging all of process.env here
// would silently bypass that allowlist for tmux/subprocess workers.
const WORKER_BASE_ENV_KEYS = Object.freeze([
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
  // Windows subprocesses need these non-secret runtime variables to resolve
  // .cmd shims, start the command shell, and locate CLI config/auth stores.
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
      throw new Error('manager capability is disabled by actor token policy');
    }
    env.PALANTIR_MANAGER_TOKEN = managerToken;
  }
  return env;
}

function applyWorkerCredentialPolicy(explicitEnv = {}, {
  workerToken = null,
  apiBase = null,
  actorTokens = null,
} = {}) {
  const merged = stripActorCredentials({ ...(explicitEnv || {}) });
  if (typeof workerToken === 'string' && workerToken) {
    if (!actorTokenPolicyFrom(actorTokens).capabilitiesEnabled) {
      throw new Error('worker capability is disabled by actor token policy');
    }
    merged.PALANTIR_WORKER_TOKEN = workerToken;
  }
  if (typeof apiBase === 'string' && apiBase) {
    merged.PALANTIR_API_BASE = apiBase.replace(/\/+$/, '');
  }
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
  now = () => Date.now(),
  // Managers are long-lived sessions and the token is injected once, at spawn —
  // there is no channel to hand the process a fresh one. A 5-minute TTL
  // therefore did not attenuate anything, it just made the whole capability
  // stop working five minutes in, which is the exact 403 this issue is about.
  //
  // Real revocation here is run-boundedness, enforced synchronously on EVERY
  // request: the grant must match a live registry slot whose run is still
  // non-terminal (see isManagerCapabilityActive). Ending the run kills the
  // token immediately, which a wall clock cannot do. The absolute expiry stays
  // as a backstop for a credential that leaks into a log and is replayed long
  // after, so it is sized to a working session rather than to a turn.
  attenuatedTtlMs = Number.parseInt(process.env.PALANTIR_MANAGER_TOKEN_TTL_MS || '', 10) > 0
    ? Math.min(Number.parseInt(process.env.PALANTIR_MANAGER_TOKEN_TTL_MS, 10), 24 * 60 * 60 * 1000)
    : 8 * 60 * 60 * 1000,
} = {}) {
  const policy = actorTokenPolicyFrom(actorTokens);
  const signingKey = policy.capabilitiesEnabled
    ? (injectedSigningKey || crypto.randomBytes(32))
    : null;
  const MAX_ATTENUATED_TTL_MS = 24 * 60 * 60 * 1000;
  if (!Number.isSafeInteger(attenuatedTtlMs) || attenuatedTtlMs <= 0 || attenuatedTtlMs > MAX_ATTENUATED_TTL_MS) {
    throw new Error(`attenuated manager capability TTL must be 1..${MAX_ATTENUATED_TTL_MS}ms`);
  }

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
    const baseClaims = {
      runId: id,
      conversationId: conversation,
      layer: managerLayer,
    };
    // Keep verified/isolated tokens byte-for-byte compatible. The attenuated
    // format carries its honest tier plus an absolute expiry and is never
    // accepted after that deadline.
    const claims = policy.capabilityTier === 'shared_uid_attenuated'
      ? {
        ...baseClaims,
        capabilityTier: 'shared_uid_attenuated',
        expiresAt: now() + attenuatedTtlMs,
      }
      : baseClaims;
    const encoded = Buffer.from(JSON.stringify(claims), 'utf8').toString('base64url');
    const version = policy.capabilityTier === 'shared_uid_attenuated'
      ? 'manager-v2'
      : 'manager-v1';
    const signature = crypto
      .createHmac('sha256', signingKey)
      .update(`${version}\0${encoded}`)
      .digest('base64url');
    return `${version === 'manager-v2' ? 'palm2' : 'palm1'}.${encoded}.${signature}`;
  }

  const NOT_A_TOKEN = Object.freeze({ signatureValid: false, expired: false, grant: null });

  function inspectToken(token) {
    if (!signingKey || typeof token !== 'string') return NOT_A_TOKEN;
    const parts = token.split('.');
    const attenuated = parts[0] === 'palm2';
    if (
      parts.length !== 3
      || (parts[0] !== 'palm1' && !attenuated)
      || (attenuated && policy.capabilityTier !== 'shared_uid_attenuated')
    ) return NOT_A_TOKEN;
    let claims;
    try {
      claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    } catch {
      return NOT_A_TOKEN;
    }
    const runId = claims && typeof claims === 'object' && !Array.isArray(claims)
      ? claims.runId
      : null;
    const conversationId = claims && typeof claims === 'object'
      ? claims.conversationId
      : null;
    const layer = claims && typeof claims === 'object' ? claims.layer : null;
    const capabilityTier = claims && typeof claims === 'object'
      ? claims.capabilityTier
      : null;
    const expiresAt = claims && typeof claims === 'object'
      ? claims.expiresAt
      : null;
    const canonicalClaims = attenuated
      ? { runId, conversationId, layer, capabilityTier, expiresAt }
      : { runId, conversationId, layer };
    if (
      typeof runId !== 'string'
      || !/^[A-Za-z0-9_-]{1,128}$/.test(runId)
      || (
        conversationId !== 'top'
        && !/^operator:[A-Za-z0-9_-]{1,128}$/.test(conversationId)
      )
      || !['top', 'operator', 'pm'].includes(layer)
      || (attenuated && (
        capabilityTier !== 'shared_uid_attenuated'
        || !Number.isSafeInteger(expiresAt)
      ))
      || Buffer.from(JSON.stringify(canonicalClaims), 'utf8').toString('base64url') !== parts[1]
    ) {
      return NOT_A_TOKEN;
    }
    const expected = crypto
      .createHmac('sha256', signingKey)
      .update(`${attenuated ? 'manager-v2' : 'manager-v1'}\0${parts[1]}`)
      .digest();
    let presented;
    try { presented = Buffer.from(parts[2], 'base64url'); } catch { return NOT_A_TOKEN; }
    if (presented.length !== expected.length || !crypto.timingSafeEqual(presented, expected)) {
      return NOT_A_TOKEN;
    }
    // #436: expiry is evaluated AFTER the signature so a validly-signed but
    // expired capability is distinguishable from a forgery. It still fails, but
    // it is a REAL credential used past its life, which the audit has to record.
    // Checking expiry first made that request look like garbage and it left no
    // trace at all.
    const grant = attenuated
      ? { runId, conversationId, layer, capabilityTier, expiresAt }
      : { runId, conversationId, layer };
    return { signatureValid: true, expired: !!(attenuated && expiresAt <= now()), grant };
  }

  // Full-fidelity result for the audit path: tells "not our token" apart from
  // "our token, expired". Authorization callers use verify().
  function inspect(token) {
    return inspectToken(token);
  }

  function verify(token) {
    const result = inspectToken(token);
    return result.signatureValid && !result.expired ? result.grant : null;
  }

  return { mint, verify, inspect };
}

module.exports = {
  ACTOR_TOKEN_KEYS,
  resolveDotEnvPath,
  assertNoActorTokensInDotEnv,
  consumeActorTokenFile,
  prepareActorTokenEnvironment,
  resolveActorTokenPolicy,
  scanAmbientActorTokens,
  hadAmbientActorTokensAtLoad,
  isActorCredentialKey,
  buildWorkerProcessEnv,
  augmentProcessPath,
  applyManagerCredentialPolicy,
  applyWorkerCredentialPolicy,
  createWorkerProposalTokenService,
  createManagerCapabilityTokenService,
};
