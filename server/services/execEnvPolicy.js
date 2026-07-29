'use strict';

// Keep only ambient values required to locate Git and its node-local config,
// authenticate, reach remotes, create commits, and preserve locale/temp behavior.
// Command-bearing Git settings stay caller overrides except GIT_ASKPASS: some
// private HTTPS nodes deliberately expose their only credential through that
// node-local helper.
const EXEC_ENV_KEYS = Object.freeze([
  // Git, ssh, credential helpers, and user-scoped configuration are discovered
  // through these locations; the services invoke Git by its bare command name.
  'PATH',
  'Path',
  'HOME',
  'XDG_CONFIG_HOME',
  'HOMEDRIVE',
  'HOMEPATH',
  'USERPROFILE',
  'SystemRoot',
  'SYSTEMROOT',
  'WINDIR',
  'ComSpec',
  'COMSPEC',
  'PATHEXT',

  // Locale is part of the stderr parsing contract; temp roots must stay writable.
  'LANG',
  'LANGUAGE',
  'LC_ALL',
  'LC_ADDRESS',
  'LC_COLLATE',
  'LC_CTYPE',
  'LC_IDENTIFICATION',
  'LC_MEASUREMENT',
  'LC_MESSAGES',
  'LC_MONETARY',
  'LC_NAME',
  'LC_NUMERIC',
  'LC_PAPER',
  'LC_TELEPHONE',
  'LC_TIME',
  'TMPDIR',
  'TMP',
  'TEMP',

  // Agent authentication preserves key isolation without allowing an ambient
  // ssh command to replace the transport. GIT_ASKPASS is intentionally kept:
  // it is the standard non-interactive credential boundary for private HTTPS
  // remotes and may be the node's only authentication mechanism.
  'SSH_AUTH_SOCK',
  'GIT_ASKPASS',

  // Clone/fetch/ls-remote may need the node's proxy and private CA locations.
  // These are data settings, not executable helper selections.
  'http_proxy',
  'https_proxy',
  'ftp_proxy',
  'all_proxy',
  'no_proxy',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'FTP_PROXY',
  'ALL_PROXY',
  'NO_PROXY',
  'CURL_CA_BUNDLE',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',

  // Auto-save commits need non-interactive identity when it is supplied through
  // env rather than the HOME-backed Git config.
  'EMAIL',
  'GIT_AUTHOR_NAME',
  'GIT_AUTHOR_EMAIL',
  'GIT_COMMITTER_NAME',
  'GIT_COMMITTER_EMAIL',

  // Git-specific private CA paths are the transport equivalents of the generic
  // curl/OpenSSL variables above and do not disable certificate verification.
  'GIT_SSL_CAINFO',
  'GIT_SSL_CAPATH',
]);

const EXEC_ENV_KEY_SET = new Set(EXEC_ENV_KEYS);

// A project test is arbitrary repository code, so it must never receive the
// Console's entire process environment. It does need more runtime discovery
// than Git. This list is deliberately independent from EXEC_ENV_KEYS: Git
// credentials (askpass/agent/proxy userinfo) must not silently flow into code
// that the agent can modify.
const PROJECT_TEST_ENV_KEYS = Object.freeze([
  'PATH',
  'Path',
  'HOME',
  'XDG_CONFIG_HOME',
  'HOMEDRIVE',
  'HOMEPATH',
  'USERPROFILE',
  'SystemRoot',
  'SYSTEMROOT',
  'WINDIR',
  'ComSpec',
  'COMSPEC',
  'PATHEXT',
  'USER',
  'USERNAME',
  'LOGNAME',
  'SHELL',
  'APPDATA',
  'LOCALAPPDATA',
  'PROGRAMDATA',
  'TERM',
  'COLORTERM',
  'NO_COLOR',
  'FORCE_COLOR',
  'LANG',
  'LANGUAGE',
  'LC_ALL',
  'LC_ADDRESS',
  'LC_COLLATE',
  'LC_CTYPE',
  'LC_IDENTIFICATION',
  'LC_MEASUREMENT',
  'LC_MESSAGES',
  'LC_MONETARY',
  'LC_NAME',
  'LC_NUMERIC',
  'LC_PAPER',
  'LC_TELEPHONE',
  'LC_TIME',
  'TMPDIR',
  'TMP',
  'TEMP',
  'TZ',
  'CI',
  'NODE_ENV',
  'NVM_BIN',
  'NVM_DIR',
  'NVM_SYMLINK',
  'VOLTA_HOME',
  'PNPM_HOME',
  'COREPACK_HOME',
  'VIRTUAL_ENV',
  'PYENV_ROOT',
  'CONDA_PREFIX',
  'JAVA_HOME',
  'MAVEN_HOME',
  'GRADLE_USER_HOME',
  'GOPATH',
  'GOROOT',
  'CARGO_HOME',
  'RUSTUP_HOME',
  'GEM_HOME',
  'GEM_PATH',
  'BUNDLE_PATH',
]);

const PROJECT_TEST_ENV_KEY_SET = new Set(PROJECT_TEST_ENV_KEYS);

function isExecEnvKeyAllowed(key) {
  return EXEC_ENV_KEY_SET.has(key);
}

function selectEnv(sourceEnv, allowedKeys) {
  const selected = {};
  for (const [key, value] of Object.entries(sourceEnv || {})) {
    if (value !== undefined && allowedKeys.has(key)) selected[key] = value;
  }
  return selected;
}

function mergeEnvOverrides(selected, overrides) {
  if (!overrides) return selected;
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete selected[key];
    else selected[key] = value;
  }
  return selected;
}

function selectExecEnv(sourceEnv = {}) {
  return selectEnv(sourceEnv, EXEC_ENV_KEY_SET);
}

function buildExecEnv(sourceEnv = {}, overrides) {
  return mergeEnvOverrides(selectExecEnv(sourceEnv), overrides);
}

function buildProjectTestEnv(sourceEnv = {}, overrides) {
  return mergeEnvOverrides(
    selectEnv(sourceEnv, PROJECT_TEST_ENV_KEY_SET),
    overrides,
  );
}

module.exports = {
  EXEC_ENV_KEYS,
  PROJECT_TEST_ENV_KEYS,
  isExecEnvKeyAllowed,
  selectExecEnv,
  buildExecEnv,
  buildProjectTestEnv,
};
