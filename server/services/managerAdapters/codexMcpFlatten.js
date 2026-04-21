/**
 * Flatten an MCP servers object into Codex CLI `-c <dotted.path>=<TOML>` args.
 *
 * Why this exists (M1):
 *   Codex CLI's `-c` flag value is parsed as TOML. Passing
 *     -c mcp_servers=<JSON string>
 *   makes Codex see mcp_servers as a string literal, not a table, and it
 *   fails with "invalid type: string, expected a map" — the entire config
 *   load aborts. The correct form is leaf-level dotted paths:
 *     -c mcp_servers.<alias>.command="npx"
 *     -c mcp_servers.<alias>.args=["-y","@ctx7/mcp"]
 *     -c mcp_servers.<alias>.env={CTX7_KEY="val"}
 *   Verified against codex-cli 0.120.0. Worker path (lifecycleService) and
 *   PM path (codexAdapter.spawnOneTurn) both call this same util so we
 *   don't drift between the two call sites.
 *
 * Fail-closed design:
 *   Any shape that would cause a declared server to silently vanish or
 *   reach Codex as the wrong TOML type throws instead of degrading. The
 *   caller (lifecycleService / codexAdapter) catches the throw, marks the
 *   run failed, and emits an observable event. Nothing spawns on bad input.
 *
 *   - alias, top-level keys, env keys must match /^[A-Za-z0-9_-]+$/
 *   - mcp / mcpServers / alias cfg must be plain objects (Map/Date/class
 *     instances throw — they'd become silent empties under Object.entries)
 *   - alias cfg that produces zero emitted args throws ("declared server
 *     would vanish")
 *   - encodeToml throws on unsupported types (bigint/function/symbol/
 *     non-plain-object) and non-finite numbers; null/undefined leaves are
 *     still dropped as the "optional field absent" semantic
 *   - arrays may NOT contain null/undefined holes
 *   - direct `bearer_token` values are refused; only `bearer_token_env_var`
 *     (the env-var name, not the secret) is allowed
 *
 * KNOWN LIMITATION — env values land in argv (follow-up, see docs):
 *   Every emitted arg is visible via `ps`, process listings, potentially
 *   shell history, and core dumps. That includes the inline-table form of
 *   `env`, e.g. `-c mcp_servers.<alias>.env={CTX7_TOKEN="…"}`. The
 *   `bearer_token_env_var` guard only closes the single well-known
 *   bearer-token field. Any secret placed into a plain `env` entry WILL
 *   leak through argv. Until MCP config is delivered through a file-based
 *   channel (a Palantir-owned TOML fragment merged into ~/.codex/config.toml
 *   or an alternative codex config hook), callers must treat MCP `env` as
 *   non-sensitive config only. Tracked as a follow-up to M1; see GitHub
 *   issue #113 and docs/specs/worker-preset-and-plugin-injection.md
 *   "Known limitations".
 */

const ALIAS_KEY_RE = /^[A-Za-z0-9_-]+$/;

function validateKey(context, key) {
  if (typeof key !== 'string' || !ALIAS_KEY_RE.test(key)) {
    throw new Error(`flattenMcpToCodexArgs: invalid ${context} "${key}" (must match ${ALIAS_KEY_RE})`);
  }
}

function isPlainObject(v) {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

function encodeString(s) {
  return JSON.stringify(String(s));
}

/**
 * Encode a value as a TOML right-hand-side. Returns null only for
 * `null` / `undefined` (legitimate "no value" semantic — caller drops the
 * key). Every other unencodable type throws so a declared preset field
 * cannot be silently mutated away.
 */
function encodeToml(v, context) {
  if (v === null || v === undefined) return null;
  const t = typeof v;
  if (t === 'string') return encodeString(v);
  if (t === 'number') {
    if (!Number.isFinite(v)) {
      throw new Error(`flattenMcpToCodexArgs: non-finite number at ${context} (NaN/Infinity not representable in TOML)`);
    }
    return String(v);
  }
  if (t === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) {
    const parts = [];
    for (let i = 0; i < v.length; i++) {
      const enc = encodeToml(v[i], `${context}[${i}]`);
      if (enc === null) {
        throw new Error(`flattenMcpToCodexArgs: null/undefined array element at ${context}[${i}] (arrays must not contain holes)`);
      }
      parts.push(enc);
    }
    return `[${parts.join(',')}]`;
  }
  if (isPlainObject(v)) {
    const parts = [];
    for (const [k, subv] of Object.entries(v)) {
      validateKey(`nested key at ${context}`, k);
      const enc = encodeToml(subv, `${context}.${k}`);
      if (enc === null) continue;
      parts.push(`${k}=${enc}`);
    }
    // Collapse "all leaves null/undefined" to the same absent semantic as a
    // null leaf. Otherwise `env: { TOKEN: undefined }` would emit `env={}`
    // and pass the alias-level emit count check while still representing a
    // declared-server-with-no-real-config — the silent-vanish case Codex
    // review R4 flagged.
    if (parts.length === 0) return null;
    return `{${parts.join(',')}}`;
  }
  // bigint, function, symbol, or non-plain object (Map, Date, class instance)
  throw new Error(
    `flattenMcpToCodexArgs: unsupported value type "${t === 'object' ? 'non-plain-object' : t}" at ${context}`,
  );
}

/**
 * @param {object|null|undefined} mcp  MCP config shaped as `{ mcpServers: {...} }`.
 * @returns {string[]}  Args array, interleaved `-c, '<dotted>=<toml>', -c, ...`.
 *                      Returns [] only when `mcp` is absent or has no servers.
 *                      A present-but-malformed shape (wrong type at mcpServers
 *                      root, or null/non-object alias cfg) throws rather than
 *                      degrading — preset authors rely on their declared
 *                      servers being spawned, so silent drop violates intent.
 * @throws {Error}      On invalid shape / alias / key / direct bearer_token.
 */
function flattenMcpToCodexArgs(mcp) {
  if (mcp === null || mcp === undefined) return [];
  if (!isPlainObject(mcp)) {
    throw new Error(`flattenMcpToCodexArgs: mcp must be a plain object, got ${Array.isArray(mcp) ? 'array' : typeof mcp}`);
  }
  const rawServers = mcp.mcpServers;
  if (rawServers === null || rawServers === undefined) return [];
  if (!isPlainObject(rawServers)) {
    throw new Error(
      `flattenMcpToCodexArgs: mcpServers must be a plain object map, got ${Array.isArray(rawServers) ? 'array' : typeof rawServers}`,
    );
  }
  const out = [];
  for (const [alias, cfg] of Object.entries(rawServers)) {
    validateKey('alias', alias);
    if (cfg === null || cfg === undefined) {
      throw new Error(
        `flattenMcpToCodexArgs: alias "${alias}" has null/undefined cfg (preset declared a server that has no config)`,
      );
    }
    if (!isPlainObject(cfg)) {
      throw new Error(
        `flattenMcpToCodexArgs: alias "${alias}" cfg must be a plain object, got ${Array.isArray(cfg) ? 'array' : typeof cfg}`,
      );
    }
    if (Object.prototype.hasOwnProperty.call(cfg, 'bearer_token')) {
      throw new Error(
        `flattenMcpToCodexArgs: alias "${alias}" uses direct bearer_token; use bearer_token_env_var instead (secrets must not appear in argv)`,
      );
    }
    let emittedForAlias = 0;
    for (const [key, val] of Object.entries(cfg)) {
      validateKey(`key under ${alias}`, key);
      if (key === 'env') {
        // MCP schema (Codex 0.120) declares env as map<string,string>.
        // Validate the container type upfront (non-null, non-array plain
        // object) so `env: "x"` / `env: []` / `env: 42` surface as util
        // errors rather than being deferred to Codex's TOML parser. Keeps
        // the "throws on wrong TOML type" promise in the header comment
        // honest (Codex review R4, NIT #4).
        if (val !== null && val !== undefined) {
          if (!isPlainObject(val)) {
            throw new Error(
              `flattenMcpToCodexArgs: env under ${alias} must be a plain object, got ${Array.isArray(val) ? 'array' : typeof val}`,
            );
          }
          // Reject non-string env values outright so a downstream
          // stringification bug (e.g. `env: { KEY: 42 }`) doesn't
          // silently reach the spawn as an unexpected TOML integer.
          for (const [envKey, envVal] of Object.entries(val)) {
            validateKey(`env key under ${alias}`, envKey);
            if (envVal === null || envVal === undefined) continue;
            if (typeof envVal !== 'string') {
              throw new Error(
                `flattenMcpToCodexArgs: env value for ${alias}.env.${envKey} must be a string (got ${typeof envVal})`,
              );
            }
          }
        }
      }
      const enc = encodeToml(val, `${alias}.${key}`);
      if (enc === null) continue;
      out.push('-c', `mcp_servers.${alias}.${key}=${enc}`);
      emittedForAlias += 1;
    }
    if (emittedForAlias === 0) {
      throw new Error(
        `flattenMcpToCodexArgs: alias "${alias}" produced zero args (empty cfg or all values null/undefined) — declared server would silently vanish`,
      );
    }
  }
  return out;
}

module.exports = { flattenMcpToCodexArgs };
