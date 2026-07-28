'use strict';

// Keep only ambient values required to locate Git and its node-local config,
// authenticate without launching a helper command, reach remotes, create commits,
// and preserve locale/temp behavior. Command-bearing Git settings stay caller
// overrides so materialization hardening cannot become an ambient execution path.
const EXEC_ENV_KEYS = Object.freeze([
  // Git, ssh, credential helpers, and user-scoped configuration are discovered
  // through these locations; the services invoke Git by its bare command name.
  'PATH',
  'HOME',
  'XDG_CONFIG_HOME',
  'HOMEDRIVE',
  'HOMEPATH',
  'USERPROFILE',

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
  // askpass or ssh command to execute an arbitrary program.
  'SSH_AUTH_SOCK',

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

function isExecEnvKeyAllowed(key) {
  return EXEC_ENV_KEY_SET.has(key);
}

function selectExecEnv(sourceEnv = {}) {
  const selected = {};
  for (const [key, value] of Object.entries(sourceEnv || {})) {
    if (value !== undefined && isExecEnvKeyAllowed(key)) selected[key] = value;
  }
  return selected;
}

function buildExecEnv(sourceEnv = {}, overrides) {
  const selected = selectExecEnv(sourceEnv);
  if (!overrides) return selected;
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete selected[key];
    else selected[key] = value;
  }
  return selected;
}

module.exports = {
  EXEC_ENV_KEYS,
  isExecEnvKeyAllowed,
  selectExecEnv,
  buildExecEnv,
};
