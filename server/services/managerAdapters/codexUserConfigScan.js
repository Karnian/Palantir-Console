/**
 * Scan the Codex CLI user config (~/.codex/config.toml) for already-
 * registered mcp_servers aliases, and detect conflicts with the merged
 * MCP that Palantir is about to inject via `-c` leaf-level overrides.
 *
 * Why this exists (M2):
 *   Codex's `-c mcp_servers.<alias>.<key>=` overrides merge at the LEAF
 *   level, not the alias level. If a user's ~/.codex/config.toml already
 *   declares `mcp_servers.ctx7` with `command`, `args`, and `env`, and a
 *   Palantir preset injects only `mcp_servers.ctx7.command="npx"`, the
 *   running spawn ends up with Palantir's command fused to the user's
 *   args+env — a silent drift the preset author did not intend.
 *
 *   M2 does NOT attempt to neutralize the merge (that's the M3 file-
 *   based-transport follow-up, issue #113). It only makes the drift
 *   observable by emitting `mcp:legacy_alias_conflict` run events.
 *
 * Scope discipline (per Codex M2 review):
 *   - Detection only. No value comparison, no override simulation.
 *   - Event payload is fixed at { alias, source, message } — low
 *     cardinality so M3's transport change doesn't break consumers.
 *   - Pattern scanner, not a TOML parser. False positives on pathological
 *     inputs (e.g. a `[mcp_servers.x]`-shaped substring inside a multi-
 *     line string) cost one extra warning; never a failure. No new runtime
 *     dependency.
 *
 * Covered declaration forms:
 *   [mcp_servers.<alias>]                # table header (bare key)
 *   [ mcp_servers.<alias> ]              # with inner whitespace
 *   [mcp_servers."<alias>"]              # quoted key
 *   mcp_servers.<alias>.<key> = ...      # dotted key at root
 *   mcp_servers."<alias>".<key> = ...    # dotted with quoted segment
 *
 * NOT covered: inline tables nested under a bare `[mcp_servers]` block
 * (rare in real user configs); dotted-key with a non-leaf quoted sub-key
 * at a deeper position (Codex schema never uses these shapes today).
 * These are acceptable blind spots for detection-only.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// The alias token may appear bare (^[A-Za-z0-9_-]+$) or quoted with ASCII
// basic-string quotes. We accept both forms for the table-header and
// dotted-key declarations. Anything else is intentionally out of scope
// (see header "NOT covered").
const TABLE_HEADER_RE = /^\[\s*mcp_servers\.(?:([A-Za-z0-9_-]+)|"([^"]+)")\s*\]/;
const DOTTED_KEY_RE = /^mcp_servers\.(?:([A-Za-z0-9_-]+)|"([^"]+)")\./;

/**
 * @param {string} text  Raw TOML text to scan.
 * @returns {string[]}   Deduplicated alias names. Order matches first-
 *                       appearance in the text.
 */
function extractAliasesFromToml(text) {
  if (typeof text !== 'string' || text.length === 0) return [];
  const aliases = new Set();
  const lines = text.split(/\r?\n/);
  for (const raw of lines) {
    // Naive comment strip — acceptable for detection-only. Does not
    // understand # inside basic/literal strings; false positives there
    // only cause an extra event, which is benign.
    const code = raw.replace(/#.*$/, '').trim();
    if (!code) continue;
    let m = code.match(TABLE_HEADER_RE);
    if (m) { aliases.add(m[1] || m[2]); continue; }
    m = code.match(DOTTED_KEY_RE);
    if (m) { aliases.add(m[1] || m[2]); continue; }
  }
  return [...aliases];
}

/**
 * Resolve which path scanCodexUserConfigAliases will read. Exposed so
 * callers can include the resolved path in diagnostic messages — avoids
 * hard-coding "~/.codex/config.toml" in event payloads when the path is
 * actually overridden (e.g. via $PALANTIR_CODEX_CONFIG_PATH).
 */
function resolveCodexUserConfigPath(configPath) {
  return configPath
    || process.env.PALANTIR_CODEX_CONFIG_PATH
    || path.join(os.homedir(), '.codex', 'config.toml');
}

/**
 * @param {string} [configPath]  Explicit path. Falls back to
 *                               `$PALANTIR_CODEX_CONFIG_PATH` (used by
 *                               integration tests) and finally to
 *                               `~/.codex/config.toml`.
 * @returns {string[]}           Alias list. Returns [] on any read error
 *                               (missing file, permission denied, etc.) —
 *                               "no data" is correctly "no conflict".
 */
function scanCodexUserConfigAliases(configPath) {
  const p = resolveCodexUserConfigPath(configPath);
  let text;
  try {
    text = fs.readFileSync(p, 'utf8');
  } catch {
    return [];
  }
  return extractAliasesFromToml(text);
}

/**
 * @param {object|null} mergedMcp   `{ mcpServers: {...} }` or null.
 * @param {string[]}    userAliases Alias list from scanCodexUserConfigAliases.
 * @param {object}      [opts]
 * @param {(alias:string) => string} [opts.perAliasSource]  Resolver that
 *   maps an alias to its origin ('preset' | 'project' | 'skillpack' |
 *   'pm_config' | 'unknown'). Defaults to () => 'unknown'.
 * @param {string}      [opts.configPath]  Actual path scanned — inlined
 *   into each message so the diagnostic is accurate when the default
 *   `~/.codex/config.toml` was overridden.
 * @returns {Array<{ alias: string, source: string, message: string }>}
 *   One entry per conflicting alias, matching the event payload shape.
 */
function detectLegacyAliasConflicts(mergedMcp, userAliases, { perAliasSource, configPath } = {}) {
  if (!mergedMcp || !mergedMcp.mcpServers || typeof mergedMcp.mcpServers !== 'object') return [];
  if (!Array.isArray(userAliases) || userAliases.length === 0) return [];
  const userSet = new Set(userAliases);
  const resolveSource = typeof perAliasSource === 'function' ? perAliasSource : () => 'unknown';
  const pathLabel = configPath || resolveCodexUserConfigPath();
  const out = [];
  for (const alias of Object.keys(mergedMcp.mcpServers)) {
    if (!userSet.has(alias)) continue;
    const source = resolveSource(alias) || 'unknown';
    out.push({
      alias,
      source,
      message: `alias "${alias}" (source: ${source}) already exists in ${pathLabel} — Codex will leaf-merge the two configs at spawn; preset author may not have intended this.`,
    });
  }
  return out;
}

module.exports = {
  scanCodexUserConfigAliases,
  extractAliasesFromToml,
  detectLegacyAliasConflicts,
  resolveCodexUserConfigPath,
};
