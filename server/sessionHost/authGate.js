'use strict';
const { isDeepStrictEqual } = require('node:util');
const defaultPin = require('./pin');
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const reject = reason => ({ ok: false, reason });

function validAccount(account, pin = defaultPin) {
  if (!object(account)) return false;
  const known = ['email', 'organization', 'subscriptionType', 'apiProvider'];
  return Object.keys(account).every(key => known.includes(key)) &&
    own(account, 'apiProvider') && account.apiProvider === 'firstParty' &&
    own(account, 'subscriptionType') && pin.allowedSubscriptionTypes.includes(account.subscriptionType) &&
    !('tokenSource' in account) && !('apiKeySource' in account) &&
    ['email', 'organization'].every(key => !own(account, key) || typeof account[key] === 'string');
}

function evaluateInitialization(init, { expectedPid, pin = defaultPin } = {}) {
  if (!object(init) || !validAccount(init.account, pin)) return reject('auth_source_not_subscription');
  if (!Number.isSafeInteger(expectedPid) || expectedPid <= 0 || init.pid !== expectedPid) return reject('pid_mismatch');
  if (init.claude_code_version !== pin.cliVersion) return reject('cli_version_mismatch');
  if (init.current_permission_mode !== 'default') return reject('permission_mode_mismatch');
  if (init.remote_control_auto_enable !== false) return reject('remote_control_enabled');
  return { ok: true };
}

function evaluateAccountRecheck(previousAccount, currentAccount) {
  if (!validAccount(previousAccount) || !validAccount(currentAccount)) return reject('account_check_failed');
  return isDeepStrictEqual(previousAccount, currentAccount) ? { ok: true } : reject('account_changed');
}

// Only path fields are projected. Setting values and account metadata never enter diagnostics.
function sourcePaths(value) {
  if (Array.isArray(value)) return [...new Set(value.flatMap(sourcePaths))];
  if (!object(value)) return [];
  const paths = typeof value.path === 'string' && !/[\0\r\n]/.test(value.path) ? [value.path] : [];
  return [...new Set([...paths, ...Object.entries(value).filter(([key]) => key !== 'path').flatMap(([, item]) => sourcePaths(item))])];
}

function evaluateResolvedSettings(result) {
  if (!object(result) || !object(result.effective) || !Array.isArray(result.sources) || !object(result.provenance)) {
    return reject('settings_check_failed');
  }
  const { effective, provenance } = result;
  if (own(effective, 'env') && (!object(effective.env) || !Object.values(effective.env).every(value => typeof value === 'string'))) {
    return reject('settings_check_failed');
  }
  const blocked = defaultPin.forbiddenAuthEnv.some(key => own(effective.env || {}, key));
  if (blocked || own(effective, 'apiKeyHelper')) {
    const paths = sourcePaths(blocked ? provenance.env : provenance.apiKeyHelper);
    return { ...reject('settings_auth_override'), ...(paths.length ? { detail: paths.join(', ') } : {}) };
  }
  if (own(effective, 'hooks') && !object(effective.hooks)) return reject('settings_check_failed');
  const warnings = own(effective.hooks || {}, 'PermissionRequest') ? ['permission_request_hook'] : [];
  return { ok: true, warnings, hookSources: sourcePaths(provenance.hooks), mcpSources: sourcePaths(provenance.mcpServers) };
}

async function resolveSettingsChecked(resolveSettingsFn, cwd, options = {}) {
  const deadlineMs = options.deadlineMs ?? defaultPin.resolveSettingsDeadlineMs;
  const timers = options.timers || globalThis;
  const now = options.clock || Date.now;
  if (typeof resolveSettingsFn !== 'function' || !Number.isFinite(deadlineMs) || deadlineMs <= 0) {
    return reject('settings_check_failed');
  }
  let timer;
  try {
    const started = now();
    const timeout = new Promise(resolve => {
      timer = timers.setTimeout(() => resolve(reject('settings_check_failed')), deadlineMs);
    });
    const checked = Promise.resolve().then(() => resolveSettingsFn({ cwd })).then(result => {
      if (now() - started >= deadlineMs) return reject('settings_check_failed');
      return evaluateResolvedSettings(result);
    });
    return await Promise.race([checked, timeout]);
  } catch {
    return reject('settings_check_failed');
  } finally {
    if (timer !== undefined) timers.clearTimeout(timer);
  }
}

function evaluateSystemInit(message, pin = defaultPin) {
  if (!object(message) || message.type !== 'system' || message.subtype !== 'init' || message.apiKeySource !== 'none') {
    return reject('auth_source_not_subscription');
  }
  if (!Array.isArray(message.capabilities) || !pin.requiredCapabilities.every(value => message.capabilities.includes(value))) {
    return reject('capability_missing');
  }
  return { ok: true };
}
module.exports = { evaluateInitialization, evaluateAccountRecheck, evaluateResolvedSettings, resolveSettingsChecked, evaluateSystemInit };
