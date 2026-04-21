// Shared env-var hard denylist for MCP server configuration. Extracted so
// both skillPackService (env_overrides validation) and mcpTemplateService
// (allowed_env_keys validation on template CRUD) can reuse the same rules
// without a circular dependency. Keep this file free of side effects —
// pure regex + predicate, no DB or service imports.
//
// Patterns mirror the historical list from skillPackService §2.2.1:
//   - Credential suffixes that indicate secrets
//   - Process-loader variables that enable code injection (NODE_OPTIONS,
//     LD_PRELOAD, DYLD_*, PYTHONPATH, etc.)
//   - Path/config hijack variables (PATH, HOME, GIT_CONFIG_*)
//
// A key hitting any of these is rejected from allowed_env_keys / env_overrides
// even if the caller is a trusted local operator — the same curated MCP
// server would leak across tenants if this list ever weakens.

const ENV_HARD_DENYLIST_PATTERNS = [
  // Credential patterns
  /_KEY$/, /_SECRET$/, /_TOKEN$/, /_PASSWORD$/, /_CREDENTIAL$/, /_CREDENTIALS$/,
  /_CERT$/, /_PRIVATE$/,
  // Process-loader patterns
  /^NODE_OPTIONS$/, /^NODE_EXTRA_CA_CERTS$/, /^LD_PRELOAD$/, /^LD_LIBRARY_PATH$/,
  /^DYLD_/, /^PYTHONPATH$/, /^RUBYOPT$/, /^PERL5OPT$/, /^JAVA_TOOL_OPTIONS$/,
  // Path/config hijack
  /^PATH$/, /^HOME$/, /^SHELL$/, /^GIT_CONFIG_GLOBAL$/, /^GIT_CONFIG_SYSTEM$/,
  /^XDG_CONFIG_HOME$/,
];

function isEnvKeyDenied(key) {
  return ENV_HARD_DENYLIST_PATTERNS.some((pattern) => pattern.test(key));
}

module.exports = { ENV_HARD_DENYLIST_PATTERNS, isEnvKeyDenied };
