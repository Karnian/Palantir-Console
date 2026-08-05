const CONFIG_ENV_KEY = 'PALANTIR_CLAUDE_REFRESH_CONFIG_JSON';

const UNSAFE_OBJECT_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
// This path is opt-in and has NOT been verified against a live refresh
// endpoint. Until endpoint/client/grant/rotation behavior is proven, accept
// only exact Anthropic-owned hosts and fail closed for every other host.
const CLAUDE_REFRESH_ENDPOINT_HOST_ALLOWLIST = Object.freeze([
  'api.anthropic.com',
  'console.anthropic.com',
]);

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertConfigString(value, label, { maxLength = 2048 } = {}) {
  if (typeof value !== 'string' || value.length === 0 || value.length > maxLength) {
    throw new Error(`${label} must be a non-empty string`);
  }
  if (/[\x00-\x1F\x7F]/.test(value)) {
    throw new Error(`${label} must not contain control characters`);
  }
  return value;
}

function assertFieldName(value, label) {
  const field = assertConfigString(value, label, { maxLength: 128 });
  if (UNSAFE_OBJECT_KEYS.has(field)) throw new Error(`${label} is not allowed`);
  return field;
}

function normalizeExpiryMapping(response, prefix, { required = false } = {}) {
  const inFieldKey = `${prefix}InField`;
  const atFieldKey = `${prefix}AtField`;
  const unitKey = `${prefix}Unit`;
  const inField = response[inFieldKey];
  const atField = response[atFieldKey];
  if ((inField === undefined) === (atField === undefined)) {
    if (!required && inField === undefined) return null;
    throw new Error(`response must set exactly one of ${inFieldKey} or ${atFieldKey}`);
  }
  const unit = response[unitKey];
  if (unit !== 'seconds' && unit !== 'milliseconds') {
    throw new Error(`response.${unitKey} must be seconds or milliseconds`);
  }
  return inField !== undefined
    ? { kind: 'in', field: assertFieldName(inField, `response.${inFieldKey}`), unit }
    : { kind: 'at', field: assertFieldName(atField, `response.${atFieldKey}`), unit };
}

function validateClaudeRefreshConfig(input) {
  if (!isPlainObject(input)) throw new Error('refresh config must be an object');
  if (input.enabled !== true) throw new Error('refresh config must set enabled=true');

  const endpoint = assertConfigString(input.endpoint, 'endpoint', { maxLength: 4096 });
  let endpointUrl;
  try {
    endpointUrl = new URL(endpoint);
  } catch {
    throw new Error('endpoint must be an absolute URL');
  }
  if (
    endpointUrl.protocol !== 'https:'
    || endpointUrl.username
    || endpointUrl.password
    || endpointUrl.hash
  ) {
    throw new Error('endpoint must be an HTTPS URL without credentials or a fragment');
  }
  if (!CLAUDE_REFRESH_ENDPOINT_HOST_ALLOWLIST.includes(endpointUrl.hostname)) {
    const error = new Error('endpoint host is not an allowed Anthropic host');
    error.code = 'CLAUDE_REFRESH_ENDPOINT_NOT_ALLOWED';
    throw error;
  }

  const request = input.request;
  if (!isPlainObject(request)) throw new Error('request config must be an object');
  if (request.method !== 'POST') throw new Error('request.method must be POST');
  if (request.encoding !== 'form' && request.encoding !== 'json') {
    throw new Error('request.encoding must be form or json');
  }
  const clientId = assertConfigString(request.clientId, 'request.clientId', { maxLength: 4096 });
  const clientIdParam = assertFieldName(request.clientIdParam, 'request.clientIdParam');
  const refreshTokenParam = assertFieldName(request.refreshTokenParam, 'request.refreshTokenParam');
  if (clientIdParam === refreshTokenParam) {
    throw new Error('client and refresh-token parameter names must differ');
  }

  const grantParams = request.grantParams;
  if (!isPlainObject(grantParams)) throw new Error('request.grantParams must be an object');
  const normalizedGrantParams = {};
  for (const [key, value] of Object.entries(grantParams)) {
    assertFieldName(key, 'request.grantParams key');
    if (key === clientIdParam || key === refreshTokenParam) {
      throw new Error('grantParams must not shadow configured credential parameters');
    }
    if (!['string', 'number', 'boolean'].includes(typeof value)) {
      throw new Error(`request.grantParams.${key} must be a scalar`);
    }
    normalizedGrantParams[key] = value;
  }

  const headers = request.headers === undefined ? {} : request.headers;
  if (!isPlainObject(headers)) throw new Error('request.headers must be an object');
  const normalizedHeaders = {};
  for (const [key, value] of Object.entries(headers)) {
    const header = assertConfigString(key, 'request.headers key', { maxLength: 128 });
    normalizedHeaders[header] = assertConfigString(value, `request.headers.${header}`, { maxLength: 4096 });
  }

  const response = input.response;
  if (!isPlainObject(response)) throw new Error('response config must be an object');
  const accessTokenField = assertFieldName(response.accessTokenField, 'response.accessTokenField');
  const refreshTokenField = assertFieldName(response.refreshTokenField, 'response.refreshTokenField');
  if (
    response.refreshTokenOmission !== 'required'
    && response.refreshTokenOmission !== 'reuse'
  ) {
    throw new Error('response.refreshTokenOmission must be required or reuse');
  }
  const accessExpiry = normalizeExpiryMapping(response, 'accessTokenExpires', { required: true });
  const refreshExpiry = normalizeExpiryMapping(response, 'refreshTokenExpires');

  const timeoutMs = input.timeoutMs === undefined ? 8000 : Number(input.timeoutMs);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 30000) {
    throw new Error('timeoutMs must be an integer between 1000 and 30000');
  }

  return {
    enabled: true,
    endpoint: endpointUrl.toString(),
    timeoutMs,
    request: {
      method: 'POST',
      encoding: request.encoding,
      clientId,
      clientIdParam,
      refreshTokenParam,
      grantParams: normalizedGrantParams,
      headers: normalizedHeaders,
    },
    response: {
      accessTokenField,
      refreshTokenField,
      refreshTokenOmission: response.refreshTokenOmission,
      accessExpiry,
      refreshExpiry,
    },
  };
}

function resolveClaudeRefreshConfig(env = process.env) {
  const raw = env?.[CONFIG_ENV_KEY];
  if (raw === undefined || raw === null || raw === '') {
    return { enabled: false, reason: 'unset', config: null };
  }
  let parsed;
  try {
    parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch {
    return { enabled: false, reason: 'invalid', config: null };
  }
  if (isPlainObject(parsed) && parsed.enabled === false) {
    return { enabled: false, reason: 'disabled', config: null };
  }
  try {
    return {
      enabled: true,
      reason: null,
      config: validateClaudeRefreshConfig(parsed),
    };
  } catch (error) {
    return {
      enabled: false,
      reason: error?.code === 'CLAUDE_REFRESH_ENDPOINT_NOT_ALLOWED'
        ? 'endpoint_not_allowed'
        : 'invalid',
      config: null,
    };
  }
}

function credentialRawMatches(expectedRaw, actualRaw) {
  return expectedRaw === actualRaw;
}

function mergeClaudeCredentialDocument(document, refreshed) {
  const oauth = document.claudeAiOauth;
  return {
    ...document,
    claudeAiOauth: {
      ...oauth,
      accessToken: refreshed.accessToken,
      refreshToken: refreshed.refreshToken,
      expiresAt: refreshed.expiresAt,
      ...(refreshed.refreshTokenExpiresAt === undefined
        ? {}
        : { refreshTokenExpiresAt: refreshed.refreshTokenExpiresAt }),
    },
  };
}

/**
 * Run the opt-in pod-side refresh transaction.
 *
 * This function intentionally contains its runtime dependencies behind options
 * or core-module requires so the exact implementation can be serialized into
 * the fixed SSH probe. Tests call it directly with fake transports; production
 * reads the validated config from stdin.
 */
async function runClaudeCredentialRefreshProbe(options = {}) {
  const fs = options.fs || require('node:fs/promises');
  const fsConstants = options.fsConstants || require('node:fs').constants;
  const path = options.path || require('node:path');
  const os = options.os || require('node:os');
  const crypto = options.crypto || require('node:crypto');
  const https = options.https || require('node:https');
  const env = options.env || process.env;
  const now = options.now || (() => Date.now());
  const sleep = options.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const platform = options.platform || process.platform;
  const hooks = options.hooks || {};

  const MAX_CREDENTIAL_BYTES = 1024 * 1024;
  const MAX_REFRESH_RESPONSE_BYTES = 64 * 1024;
  const MAX_USAGE_RESPONSE_BYTES = 256 * 1024;
  const LOCK_STALE_MS = options.lockStaleMs || 15000;
  const LOCK_UPDATE_MS = options.lockUpdateMs || Math.floor(LOCK_STALE_MS / 2);
  const LOCK_RETRIES = options.lockRetries ?? 10;
  const JOURNAL_NAME = '.palantir-claude-refresh-transaction.json';

  function result(code, stdout, reason) {
    return { code, stdout: stdout || '', stderr: '', reason };
  }

  function tokenExpired(reason = 'token_expired') {
    return result(4, '__CLAUDE_TOKEN_EXPIRED__', reason);
  }

  function ambiguous(reason) {
    return result(8, '__CLAUDE_REFRESH_AMBIGUOUS__', reason);
  }

  function isExpired(oauth) {
    const expiresAt = Number(oauth?.expiresAt);
    return Number.isFinite(expiresAt) && now() >= expiresAt;
  }

  function hash(raw) {
    return crypto.createHash('sha256').update(raw).digest('hex');
  }

  async function readConfigFromStdin() {
    let raw = '';
    for await (const chunk of process.stdin) {
      raw += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
      if (Buffer.byteLength(raw) > 64 * 1024) throw new Error('refresh config exceeds limit');
    }
    return JSON.parse(raw);
  }

  async function openRegularFile(filePath, maxBytes) {
    const noFollow = Number(fsConstants.O_NOFOLLOW || 0);
    const handle = await fs.open(filePath, Number(fsConstants.O_RDONLY) | noFollow);
    try {
      const stat = await handle.stat();
      if (!stat.isFile()) throw new Error('credential path is not a regular file');
      if (stat.size > maxBytes) throw new Error('credential file exceeds limit');
      const raw = await handle.readFile({ encoding: 'utf8' });
      return { raw, stat };
    } finally {
      await handle.close();
    }
  }

  async function readCredentialSnapshot(credentialsPath) {
    const { raw, stat } = await openRegularFile(credentialsPath, MAX_CREDENTIAL_BYTES);
    const document = JSON.parse(raw);
    if (!isPlainObject(document) || !isPlainObject(document.claudeAiOauth)) {
      throw new Error('credential file has an unsupported shape');
    }
    const directory = path.dirname(credentialsPath);
    const directoryStat = await fs.stat(directory);
    if (!directoryStat.isDirectory()) throw new Error('credential directory is not a directory');
    return {
      raw,
      document,
      stat,
      directory,
      directoryStat,
      sha256: hash(raw),
    };
  }

  function sameInode(left, right) {
    return Number(left.dev) === Number(right.dev) && Number(left.ino) === Number(right.ino);
  }

  async function assertDirectoryUnchanged(snapshot) {
    const current = await fs.stat(snapshot.directory);
    if (!current.isDirectory() || !sameInode(snapshot.directoryStat, current)) {
      throw new Error('credential directory changed during refresh');
    }
  }

  async function syncDirectory(directory) {
    let handle;
    try {
      handle = await fs.open(directory, Number(fsConstants.O_RDONLY));
      await handle.sync();
    } finally {
      await handle?.close();
    }
  }

  async function atomicWriteSecure(filePath, raw, metadata, directorySnapshot) {
    await assertDirectoryUnchanged(directorySnapshot);
    const directory = path.dirname(filePath);
    const temporaryPath = path.join(
      directory,
      `.${path.basename(filePath)}.tmp-${process.pid}-${crypto.randomBytes(8).toString('hex')}`,
    );
    let handle;
    try {
      const flags = Number(fsConstants.O_WRONLY)
        | Number(fsConstants.O_CREAT)
        | Number(fsConstants.O_EXCL)
        | Number(fsConstants.O_NOFOLLOW || 0);
      handle = await fs.open(temporaryPath, flags, 0o600);
      await handle.writeFile(raw, { encoding: 'utf8' });
      await handle.chmod(0o600);
      if (Number.isInteger(metadata.uid) && Number.isInteger(metadata.gid)) {
        await handle.chown(metadata.uid, metadata.gid);
      }
      await handle.sync();
      await handle.close();
      handle = null;
      await fs.rename(temporaryPath, filePath);
      await fs.chmod(filePath, 0o600);
      await syncDirectory(directory);
    } catch (error) {
      await handle?.close().catch(() => {});
      await fs.unlink(temporaryPath).catch(() => {});
      throw error;
    }
  }

  async function readJournal(journalPath) {
    try {
      const { raw } = await openRegularFile(journalPath, MAX_CREDENTIAL_BYTES * 2);
      const journal = JSON.parse(raw);
      if (
        !isPlainObject(journal)
        || journal.version !== 1
        || !['intent', 'ambiguous', 'staged'].includes(journal.state)
        || typeof journal.baselineSha256 !== 'string'
      ) {
        throw new Error('refresh journal has an unsupported shape');
      }
      if (journal.state === 'staged') {
        if (
          !isPlainObject(journal.nextCredentials)
          || typeof journal.nextSha256 !== 'string'
        ) {
          throw new Error('staged refresh journal is incomplete');
        }
      }
      return journal;
    } catch (error) {
      if (error?.code === 'ENOENT') return null;
      throw error;
    }
  }

  async function writeJournal(journalPath, journal, snapshot) {
    await atomicWriteSecure(
      journalPath,
      JSON.stringify(journal),
      snapshot.stat,
      snapshot,
    );
  }

  async function removeJournal(journalPath, directory) {
    try {
      await fs.unlink(journalPath);
      await syncDirectory(directory);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }

  async function acquireStorageLock(directory) {
    // Claude Code secureStorage locks "<configDir>/.storage-write" with
    // proper-lockfile. That protocol materializes this exact sibling directory,
    // so mkdir/rmdir participation coordinates with the CLI without importing
    // its private bundle. The retry and 15-second stale values also match the
    // inspected 2.1.220 implementation.
    const lockPath = path.join(directory, '.storage-write.lock');
    let lockStat = null;
    for (let attempt = 0; ; attempt += 1) {
      try {
        await fs.mkdir(lockPath, { mode: 0o700 });
        lockStat = await fs.stat(lockPath);
        break;
      } catch (error) {
        if (error?.code !== 'EEXIST') throw error;
        let existing = null;
        try {
          existing = await fs.stat(lockPath);
        } catch (statError) {
          if (statError?.code === 'ENOENT') continue;
          throw statError;
        }
        if (now() - Number(existing.mtimeMs) > LOCK_STALE_MS) {
          try {
            await fs.rmdir(lockPath);
            continue;
          } catch (removeError) {
            if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(removeError?.code)) {
              throw removeError;
            }
          }
        }
        if (attempt >= LOCK_RETRIES) {
          const lockError = new Error('Claude credential lock timed out');
          lockError.code = 'LOCK_TIMEOUT';
          throw lockError;
        }
        await sleep(Math.min(100 * (2 ** attempt), 1000));
      }
    }

    let compromised = null;
    let heartbeatRunning = false;
    const heartbeat = setInterval(async () => {
      if (heartbeatRunning || compromised) return;
      heartbeatRunning = true;
      try {
        const current = await fs.stat(lockPath);
        if (!sameInode(lockStat, current)) throw new Error('Claude credential lock was replaced');
        const date = new Date(now());
        await fs.utimes(lockPath, date, date);
      } catch (error) {
        compromised = error;
      } finally {
        heartbeatRunning = false;
      }
    }, LOCK_UPDATE_MS);
    if (typeof heartbeat.unref === 'function') heartbeat.unref();

    async function assertOwned() {
      if (compromised) throw compromised;
      const current = await fs.stat(lockPath);
      if (!sameInode(lockStat, current)) throw new Error('Claude credential lock was replaced');
    }

    async function release() {
      clearInterval(heartbeat);
      while (heartbeatRunning) await sleep(1);
      if (compromised) return;
      try {
        await assertOwned();
        await fs.rmdir(lockPath);
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
      }
    }

    return { assertOwned, release };
  }

  function responseNumber(payload, mapping, label) {
    const value = Number(payload[mapping.field]);
    if (!Number.isFinite(value) || value <= 0) {
      throw new Error(`${label} is missing or invalid`);
    }
    const milliseconds = mapping.unit === 'seconds' ? value * 1000 : value;
    const currentTime = now();
    const expiresAt = mapping.kind === 'in' ? currentTime + milliseconds : milliseconds;
    if (!Number.isFinite(milliseconds) || !Number.isFinite(expiresAt) || expiresAt <= currentTime) {
      throw new Error(`${label} must resolve to a finite future timestamp`);
    }
    return expiresAt;
  }

  function normalizeRefreshResponse(payload, config, previousRefreshToken) {
    if (!isPlainObject(payload)) throw new Error('refresh response must be an object');
    const responseConfig = config.response;
    const accessToken = payload[responseConfig.accessTokenField];
    if (typeof accessToken !== 'string' || accessToken.length === 0) {
      throw new Error('refresh response has no access token');
    }
    let refreshToken = payload[responseConfig.refreshTokenField];
    if (typeof refreshToken !== 'string' || refreshToken.length === 0) {
      if (responseConfig.refreshTokenOmission === 'reuse') refreshToken = previousRefreshToken;
      else throw new Error('refresh response has no refresh token');
    }
    return {
      accessToken,
      refreshToken,
      expiresAt: responseNumber(payload, responseConfig.accessExpiry, 'access-token expiry'),
      ...(responseConfig.refreshExpiry
        ? {
          refreshTokenExpiresAt: responseNumber(
            payload,
            responseConfig.refreshExpiry,
            'refresh-token expiry',
          ),
        }
        : {}),
    };
  }

  function buildRefreshRequest(config, refreshToken) {
    const requestConfig = config.request;
    const parameters = {
      ...requestConfig.grantParams,
      [requestConfig.clientIdParam]: requestConfig.clientId,
      [requestConfig.refreshTokenParam]: refreshToken,
    };
    const headers = { ...requestConfig.headers };
    let body;
    if (requestConfig.encoding === 'form') {
      body = new URLSearchParams(
        Object.entries(parameters).map(([key, value]) => [key, String(value)]),
      ).toString();
      if (!Object.keys(headers).some((key) => key.toLowerCase() === 'content-type')) {
        headers['Content-Type'] = 'application/x-www-form-urlencoded';
      }
    } else {
      body = JSON.stringify(parameters);
      if (!Object.keys(headers).some((key) => key.toLowerCase() === 'content-type')) {
        headers['Content-Type'] = 'application/json';
      }
    }
    headers['Content-Length'] = String(Buffer.byteLength(body));
    return {
      endpoint: config.endpoint,
      method: requestConfig.method,
      headers,
      body,
      timeoutMs: config.timeoutMs,
    };
  }

  async function requestText(requestOptions, maxBytes) {
    return new Promise((resolve, reject) => {
      const url = new URL(requestOptions.endpoint);
      let settled = false;
      const request = https.request({
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port || undefined,
        path: `${url.pathname}${url.search}`,
        method: requestOptions.method,
        headers: requestOptions.headers,
        timeout: requestOptions.timeoutMs,
      }, (response) => {
        let body = '';
        response.on('data', (chunk) => {
          if (settled) return;
          body += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
          if (Buffer.byteLength(body) > maxBytes) {
            settled = true;
            request.destroy();
            reject(new Error('response exceeded limit'));
          }
        });
        response.on('end', () => {
          if (settled) return;
          settled = true;
          resolve({ statusCode: Number(response.statusCode || 0), body });
        });
      });
      request.on('timeout', () => request.destroy(new Error('request timed out')));
      request.on('error', (error) => {
        if (settled) return;
        settled = true;
        reject(error);
      });
      request.end(requestOptions.body);
    });
  }

  async function defaultRequestRefresh({ config, refreshToken }) {
    const response = await requestText(
      buildRefreshRequest(config, refreshToken),
      MAX_REFRESH_RESPONSE_BYTES,
    );
    if (response.statusCode !== 200) throw new Error('refresh endpoint rejected request');
    try {
      return JSON.parse(response.body);
    } catch {
      const error = new Error('refresh endpoint returned unreadable JSON');
      error.code = 'CLAUDE_REFRESH_RESPONSE_UNREADABLE';
      error.unreadableResponse = response.body;
      throw error;
    }
  }

  async function defaultRequestUsage({ accessToken }) {
    return requestText({
      endpoint: 'https://api.anthropic.com/api/oauth/usage',
      method: 'GET',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'anthropic-beta': 'oauth-2025-04-20',
        Accept: 'application/json',
      },
      body: '',
      timeoutMs: 8000,
    }, MAX_USAGE_RESPONSE_BYTES);
  }

  async function queryUsage(accessToken) {
    if (typeof accessToken !== 'string' || accessToken.length === 0) {
      return result(3, '__NO_CLAUDE_TOKEN__', 'no_access_token');
    }
    try {
      const response = await (options.requestUsage || defaultRequestUsage)({ accessToken });
      if (response.statusCode !== 200) {
        return result(
          5,
          `__CLAUDE_USAGE_HTTP_${Number(response.statusCode || 0)}__`,
          'usage_http_error',
        );
      }
      if (Buffer.byteLength(String(response.body || '')) > MAX_USAGE_RESPONSE_BYTES) {
        return result(6, '', 'usage_response_too_large');
      }
      return result(0, String(response.body || ''), 'usage_ok');
    } catch {
      return result(7, '', 'usage_network_error');
    }
  }

  let config;
  try {
    const rawConfig = options.config === undefined ? await readConfigFromStdin() : options.config;
    config = validateClaudeRefreshConfig(rawConfig);
  } catch {
    return tokenExpired('refresh_config_invalid');
  }

  // The plaintext file is not Claude Code's source of truth on macOS.
  if (platform === 'darwin') return tokenExpired('plaintext_not_authoritative');

  const configDirectory = env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
  const credentialsPath = options.credentialsPath
    || path.join(configDirectory, '.credentials.json');
  let initial;
  try {
    initial = await readCredentialSnapshot(credentialsPath);
  } catch {
    return result(3, '__NO_CLAUDE_TOKEN__', 'credentials_unreadable');
  }

  const initialOauth = initial.document.claudeAiOauth;
  if (typeof initialOauth.accessToken !== 'string' || initialOauth.accessToken.length === 0) {
    return result(3, '__NO_CLAUDE_TOKEN__', 'no_access_token');
  }
  if (!isExpired(initialOauth)) return queryUsage(initialOauth.accessToken);
  if (typeof initialOauth.refreshToken !== 'string' || initialOauth.refreshToken.length === 0) {
    return tokenExpired('no_refresh_token');
  }

  let lock;
  try {
    lock = await acquireStorageLock(initial.directory);
  } catch {
    return tokenExpired('lock_unavailable');
  }

  let outcome;
  const journalPath = path.join(initial.directory, JOURNAL_NAME);
  try {
    await lock.assertOwned();
    const lockedSnapshot = await readCredentialSnapshot(credentialsPath);
    const journal = await readJournal(journalPath);

    if (journal) {
      if (
        journal.state === 'staged'
        && lockedSnapshot.sha256 === journal.nextSha256
      ) {
        await removeJournal(journalPath, lockedSnapshot.directory);
        outcome = { kind: 'usage', accessToken: lockedSnapshot.document.claudeAiOauth.accessToken };
      } else if (lockedSnapshot.sha256 !== journal.baselineSha256) {
        // A staged token may be the only surviving copy after rotation. A
        // concurrent writer makes automatic commit unsafe, but it never makes
        // deleting the journal safe. Preserve every conflicting journal for
        // manual recovery rather than destroying possible successor material.
        outcome = {
          kind: 'result',
          value: ambiguous(
            journal.state === 'staged'
              ? 'staged_credential_conflict'
              : 'refresh_journal_credential_conflict',
          ),
        };
      } else if (journal.state === 'staged') {
        const nextRaw = JSON.stringify(journal.nextCredentials);
        if (hash(nextRaw) !== journal.nextSha256) {
          outcome = { kind: 'result', value: ambiguous('staged_journal_corrupt') };
        } else {
          await lock.assertOwned();
          await atomicWriteSecure(
            credentialsPath,
            nextRaw,
            lockedSnapshot.stat,
            lockedSnapshot,
          );
          await removeJournal(journalPath, lockedSnapshot.directory);
          outcome = {
            kind: 'usage',
            accessToken: journal.nextCredentials.claudeAiOauth.accessToken,
          };
        }
      } else {
        outcome = { kind: 'result', value: ambiguous('refresh_outcome_unknown') };
      }
    } else if (!credentialRawMatches(initial.raw, lockedSnapshot.raw)) {
      const currentOauth = lockedSnapshot.document.claudeAiOauth;
      outcome = isExpired(currentOauth)
        ? { kind: 'result', value: tokenExpired('credential_changed') }
        : { kind: 'usage', accessToken: currentOauth.accessToken };
    } else {
      const baseline = initial;
      const baselineOauth = baseline.document.claudeAiOauth;
      await writeJournal(journalPath, {
        version: 1,
        state: 'intent',
        baselineSha256: baseline.sha256,
        createdAt: now(),
      }, baseline);
      if (hooks.afterIntent) await hooks.afterIntent();

      let refreshPayload;
      try {
        refreshPayload = await (options.requestRefresh || defaultRequestRefresh)({
          config,
          refreshToken: baselineOauth.refreshToken,
        });
      } catch (error) {
        if (error?.code === 'SIMULATED_CRASH') throw error;
        await writeJournal(journalPath, {
          version: 1,
          state: 'ambiguous',
          baselineSha256: baseline.sha256,
          createdAt: now(),
          ...(Object.prototype.hasOwnProperty.call(error || {}, 'unreadableResponse')
            ? { unreadableResponse: error.unreadableResponse }
            : {}),
        }, baseline);
        outcome = { kind: 'result', value: ambiguous('refresh_response_unknown') };
      }

      if (!outcome) {
        let refreshed;
        try {
          refreshed = normalizeRefreshResponse(
            refreshPayload,
            config,
            baselineOauth.refreshToken,
          );
        } catch {
          // The server ANSWERED here — only our reading of its answer failed,
          // most likely because a field name in the config is wrong. That is
          // the expected shape of a first activation, since the response schema
          // is still unconfirmed (see the blockers doc).
          //
          // If the grant rotates, the old refresh token is already spent and the
          // replacement is in this payload. Dropping it would leave nothing to
          // recover from and permanently break the CLI login on this node — the
          // single worst outcome this design exists to avoid, and worse than the
          // dropped-connection case above, where nothing was ever received.
          //
          // So it is journaled verbatim. The journal sits beside the credentials
          // file under the same 0600, and the token it may contain is already
          // the one on disk or its successor — no new exposure, and the only
          // path back to a working login.
          await writeJournal(journalPath, {
            version: 1,
            state: 'ambiguous',
            baselineSha256: baseline.sha256,
            createdAt: now(),
            unreadableResponse: refreshPayload ?? null,
          }, baseline);
          outcome = { kind: 'result', value: ambiguous('refresh_response_invalid') };
        }

        if (!outcome) {
          const nextCredentials = mergeClaudeCredentialDocument(baseline.document, refreshed);
          const nextRaw = JSON.stringify(nextCredentials);
          const staged = {
            version: 1,
            state: 'staged',
            baselineSha256: baseline.sha256,
            nextSha256: hash(nextRaw),
            nextCredentials,
            createdAt: now(),
          };
          await writeJournal(journalPath, staged, baseline);
          if (hooks.afterStage) await hooks.afterStage();

          await lock.assertOwned();
          const beforeWrite = await readCredentialSnapshot(credentialsPath);
          if (!credentialRawMatches(baseline.raw, beforeWrite.raw)) {
            outcome = { kind: 'result', value: ambiguous('credential_cas_lost') };
          } else {
            await atomicWriteSecure(
              credentialsPath,
              nextRaw,
              beforeWrite.stat,
              beforeWrite,
            );
            if (hooks.afterCredentialWrite) await hooks.afterCredentialWrite();
            await removeJournal(journalPath, beforeWrite.directory);
            outcome = { kind: 'usage', accessToken: refreshed.accessToken };
          }
        }
      }
    }
  } catch (error) {
    if (error?.code === 'SIMULATED_CRASH') throw error;
    outcome = { kind: 'result', value: tokenExpired('refresh_storage_failure') };
  } finally {
    await lock.release().catch(() => {});
  }

  if (outcome?.kind === 'usage') return queryUsage(outcome.accessToken);
  return outcome?.value || tokenExpired('refresh_failed_closed');
}

const CLAUDE_CREDENTIAL_REFRESH_PROBE_JS = [
  `const UNSAFE_OBJECT_KEYS=new Set(${JSON.stringify(Array.from(UNSAFE_OBJECT_KEYS))});`,
  `const CLAUDE_REFRESH_ENDPOINT_HOST_ALLOWLIST=Object.freeze(${JSON.stringify(CLAUDE_REFRESH_ENDPOINT_HOST_ALLOWLIST)});`,
  `const isPlainObject=${isPlainObject.toString()};`,
  `const assertConfigString=${assertConfigString.toString()};`,
  `const assertFieldName=${assertFieldName.toString()};`,
  `const normalizeExpiryMapping=${normalizeExpiryMapping.toString()};`,
  `const validateClaudeRefreshConfig=${validateClaudeRefreshConfig.toString()};`,
  `const credentialRawMatches=${credentialRawMatches.toString()};`,
  `const mergeClaudeCredentialDocument=${mergeClaudeCredentialDocument.toString()};`,
  `const runClaudeCredentialRefreshProbe=${runClaudeCredentialRefreshProbe.toString()};`,
  'runClaudeCredentialRefreshProbe().then((r)=>{if(r.stdout)process.stdout.write(r.stdout);process.exit(r.code)}).catch(()=>process.exit(4));',
].join('');

module.exports = {
  CONFIG_ENV_KEY,
  CLAUDE_CREDENTIAL_REFRESH_PROBE_JS,
  credentialRawMatches,
  mergeClaudeCredentialDocument,
  resolveClaudeRefreshConfig,
  runClaudeCredentialRefreshProbe,
  validateClaudeRefreshConfig,
};
