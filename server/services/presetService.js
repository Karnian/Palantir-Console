const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { BadRequestError, NotFoundError, ConflictError } = require('../utils/errors');

const MAX_PROMPT_BYTES = 16 * 1024; // 16KB per spec §6.8
const PROMPT_SEPARATOR = '\n\n---\n\n';

function validatePluginRefs(pluginRefs) {
  if (pluginRefs == null) return [];
  let arr = pluginRefs;
  if (typeof arr === 'string') {
    try { arr = JSON.parse(arr); } catch { throw new BadRequestError('plugin_refs must be valid JSON array'); }
  }
  if (!Array.isArray(arr)) throw new BadRequestError('plugin_refs must be an array of strings');
  for (const name of arr) {
    if (typeof name !== 'string' || !name) throw new BadRequestError('plugin_refs entries must be non-empty strings');
    // Prevent path escape — names must be bare directory names
    if (name.includes('/') || name.includes('\\') || name === '.' || name === '..') {
      throw new BadRequestError(`plugin_refs entry must be a bare directory name, got: ${JSON.stringify(name)}`);
    }
  }
  return arr;
}

function validateMcpServerIds(mcpServerIds) {
  if (mcpServerIds == null) return [];
  let arr = mcpServerIds;
  if (typeof arr === 'string') {
    try { arr = JSON.parse(arr); } catch { throw new BadRequestError('mcp_server_ids must be valid JSON array'); }
  }
  if (!Array.isArray(arr)) throw new BadRequestError('mcp_server_ids must be an array of strings');
  for (const id of arr) {
    if (typeof id !== 'string' || !id) throw new BadRequestError('mcp_server_ids entries must be non-empty strings');
  }
  return arr;
}

function validateSemver(v) {
  if (v == null || v === '') return null;
  if (typeof v !== 'string') throw new BadRequestError('min_claude_version must be a string');
  if (!/^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(v)) {
    throw new BadRequestError(`min_claude_version must be semver, got: ${JSON.stringify(v)}`);
  }
  return v;
}

// Semver comparison: returns -1 / 0 / 1. Strips pre-release for ordering (simple — enough for CLI version gate).
function compareSemver(a, b) {
  const pa = String(a).split(/[-+]/)[0].split('.').map(Number);
  const pb = String(b).split(/[-+]/)[0].split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const xa = pa[i] || 0;
    const xb = pb[i] || 0;
    if (xa < xb) return -1;
    if (xa > xb) return 1;
  }
  return 0;
}

/**
 * Walk a plugin directory, returning [{ relPath, mtimeNs, size, sha256 }, ...].
 * Excludes dotfiles (e.g. `.git`, `.palantir-manifest.json`) at any depth.
 */
function walkPluginFiles(rootDir) {
  const out = [];
  const stack = [''];
  while (stack.length > 0) {
    const relDir = stack.pop();
    const abs = path.join(rootDir, relDir);
    const entries = fs.readdirSync(abs, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const relChild = relDir ? `${relDir}/${entry.name}` : entry.name;
      const absChild = path.join(rootDir, relChild);
      if (entry.isDirectory()) {
        stack.push(relChild);
      } else if (entry.isFile()) {
        const st = fs.statSync(absChild);
        out.push({ relPath: relChild, mtimeNs: Number(st.mtimeNs), size: st.size, abs: absChild });
      }
    }
  }
  out.sort((a, b) => a.relPath.localeCompare(b.relPath));
  return out;
}

function hashFile(absPath) {
  const buf = fs.readFileSync(absPath);
  return crypto.createHash('sha256').update(buf).digest('hex');
}

/**
 * Build or rebuild the in-memory manifest for a plugin directory.
 * Cache key per file: (mtimeNs, size). Re-hash only when mtime/size changed.
 * Returns { files: [{ path, mtimeNs, size, sha256 }, ...] } sorted by path.
 */
function buildManifest(rootDir, cached) {
  const cachedMap = new Map();
  if (cached && Array.isArray(cached.files)) {
    for (const f of cached.files) cachedMap.set(f.path, f);
  }
  const files = walkPluginFiles(rootDir);
  const out = [];
  for (const f of files) {
    const prev = cachedMap.get(f.relPath);
    let sha256;
    if (prev && prev.mtimeNs === f.mtimeNs && prev.size === f.size) {
      sha256 = prev.sha256;
    } else {
      sha256 = hashFile(f.abs);
    }
    out.push({ path: f.relPath, mtimeNs: f.mtimeNs, size: f.size, sha256 });
  }
  return { files: out };
}

/**
 * Default MCP config builder from templates. Given a list of
 * mcp_server_templates rows, return a Claude-format mcp config object:
 * { "mcpServers": { alias: { command, args, env } } }.
 */
function buildMcpConfigFromTemplates(templates) {
  const mcpServers = {};
  for (const tpl of templates) {
    let args = [];
    try { args = tpl.args ? JSON.parse(tpl.args) : []; } catch { args = []; }
    mcpServers[tpl.alias] = { command: tpl.command, args };
  }
  return { mcpServers };
}

/**
 * 3-source MCP merge with precedence: preset > project > skillPack.
 * Emits `mcp:alias_conflict` warnings when the same alias appears in
 * multiple sources.
 *
 * Inputs may be null. Config shape: `{ mcpServers: { alias: config } }`.
 * Returns `{ mcpServers: {...} }` or `null` if all three are empty.
 */
function mergeMcp3(presetMcp, projectMcp, skillPackMcp, { warnings } = {}) {
  const sources = [
    { name: 'skillPack', mcp: skillPackMcp },
    { name: 'project', mcp: projectMcp },
    { name: 'preset', mcp: presetMcp },
  ];
  const out = {};
  const seen = new Map(); // alias -> [sourceName, ...] in order applied
  for (const { name, mcp } of sources) {
    if (!mcp || typeof mcp !== 'object') continue;
    const servers = mcp.mcpServers || {};
    for (const [alias, cfg] of Object.entries(servers)) {
      if (alias in out) {
        const prior = seen.get(alias) || [];
        if (warnings) {
          warnings.push({
            type: 'mcp:alias_conflict',
            alias,
            winner: name,
            sources: [...prior, name],
          });
        }
      }
      out[alias] = cfg;
      const prior = seen.get(alias) || [];
      prior.push(name);
      seen.set(alias, prior);
    }
  }
  if (Object.keys(out).length === 0) return null;
  return { mcpServers: out };
}

/**
 * Prompt chain composition per spec §6.8.
 * Order: presetPrompt → skillPackSections (priority-ordered) → adapterFooter.
 * Separator `\n\n---\n\n`. Empty components are dropped.
 */
function resolvePromptChain({ presetPrompt, skillPackSections, adapterFooter }) {
  const parts = [];
  if (presetPrompt && presetPrompt.trim()) parts.push(presetPrompt.trim());
  if (Array.isArray(skillPackSections)) {
    for (const s of skillPackSections) {
      if (s == null || s === '') continue;
      if (typeof s === 'string') {
        if (s.trim()) parts.push(s.trim());
        continue;
      }
      if (typeof s === 'object') {
        // Accept both `{ text }` (skill-pack standard) and `{ string }`
        // (alternate naming that Phase 10C consumers may use). Throw on any
        // other object shape so silent drops don't happen.
        const value = typeof s.text === 'string' ? s.text
                    : typeof s.string === 'string' ? s.string
                    : null;
        if (value === null) {
          throw new BadRequestError(
            `resolvePromptChain: unsupported section shape (expected string or { text }/{ string }, got keys: ${Object.keys(s).join(',') || '<empty>'})`,
          );
        }
        if (value.trim()) parts.push(value.trim());
        continue;
      }
      throw new BadRequestError(
        `resolvePromptChain: unsupported section type: ${typeof s}`,
      );
    }
  }
  if (adapterFooter && adapterFooter.trim()) parts.push(adapterFooter.trim());
  if (parts.length === 0) return '';
  return parts.join(PROMPT_SEPARATOR);
}

function createPresetService(db, options = {}) {
  const pluginsRoot = options.pluginsRoot
    || path.join(__dirname, '..', 'plugins');

  // In-memory manifest cache keyed by pluginName → { files: [...] }
  const manifestCache = new Map();

  const stmts = {
    getById: db.prepare('SELECT * FROM worker_presets WHERE id = ?'),
    getByName: db.prepare('SELECT * FROM worker_presets WHERE name = ?'),
    listAll: db.prepare('SELECT * FROM worker_presets ORDER BY name ASC'),
    insert: db.prepare(`
      INSERT INTO worker_presets (
        id, name, description, isolated, plugin_refs, mcp_server_ids,
        base_system_prompt, setting_sources, min_claude_version
      ) VALUES (
        @id, @name, @description, @isolated, @plugin_refs, @mcp_server_ids,
        @base_system_prompt, @setting_sources, @min_claude_version
      )
    `),
    update: db.prepare(`
      UPDATE worker_presets SET
        name = @name,
        description = @description,
        isolated = @isolated,
        plugin_refs = @plugin_refs,
        mcp_server_ids = @mcp_server_ids,
        base_system_prompt = @base_system_prompt,
        setting_sources = @setting_sources,
        min_claude_version = @min_claude_version,
        updated_at = datetime('now')
      WHERE id = @id
    `),
    delete: db.prepare('DELETE FROM worker_presets WHERE id = ?'),
    nullTaskRefs: db.prepare('UPDATE tasks SET preferred_preset_id = NULL WHERE preferred_preset_id = ?'),
    insertSnapshot: db.prepare(`
      INSERT INTO run_preset_snapshots (
        run_id, preset_id, preset_snapshot_hash, snapshot_json, file_hashes
      ) VALUES (
        @run_id, @preset_id, @preset_snapshot_hash, @snapshot_json, @file_hashes
      )
    `),
    getSnapshotByRunId: db.prepare('SELECT * FROM run_preset_snapshots WHERE run_id = ? ORDER BY id DESC LIMIT 1'),
    getMcpTemplateById: db.prepare('SELECT * FROM mcp_server_templates WHERE id = ?'),
  };

  function rowToPreset(row) {
    if (!row) return null;
    return {
      ...row,
      isolated: !!row.isolated,
      plugin_refs: safeParseArray(row.plugin_refs),
      mcp_server_ids: safeParseArray(row.mcp_server_ids),
    };
  }

  function safeParseArray(s) {
    if (!s) return [];
    try {
      const v = JSON.parse(s);
      return Array.isArray(v) ? v : [];
    } catch { return []; }
  }

  function pluginDirExists(pluginName) {
    if (!pluginName) return false;
    const absDir = path.join(pluginsRoot, pluginName);
    try {
      const manifestPath = path.join(absDir, 'plugin.json');
      return fs.statSync(manifestPath).isFile();
    } catch {
      return false;
    }
  }

  function validateBasePrompt(prompt) {
    if (prompt == null || prompt === '') return null;
    if (typeof prompt !== 'string') throw new BadRequestError('base_system_prompt must be a string');
    const bytes = Buffer.byteLength(prompt, 'utf8');
    if (bytes > MAX_PROMPT_BYTES) {
      throw new BadRequestError(`base_system_prompt exceeds ${MAX_PROMPT_BYTES} bytes (got ${bytes})`);
    }
    return prompt;
  }

  function normalizeInputs(data, { requireName = true } = {}) {
    const name = data.name != null ? String(data.name).trim() : '';
    if (requireName && !name) throw new BadRequestError('Preset name is required');

    const description = data.description != null ? String(data.description) : null;
    const isolated = data.isolated ? 1 : 0;
    const pluginRefs = validatePluginRefs(data.plugin_refs);
    const mcpServerIds = validateMcpServerIds(data.mcp_server_ids);
    const basePrompt = validateBasePrompt(data.base_system_prompt);
    const settingSources = data.setting_sources != null ? String(data.setting_sources) : '';
    const minClaudeVersion = validateSemver(data.min_claude_version);

    // Validate plugin_refs exist under pluginsRoot (US-001 save-time check)
    for (const ref of pluginRefs) {
      if (!pluginDirExists(ref)) {
        throw new BadRequestError(`Unknown plugin ref: '${ref}'`);
      }
    }

    // Validate mcp_server_ids exist
    for (const id of mcpServerIds) {
      const tpl = stmts.getMcpTemplateById.get(id);
      if (!tpl) throw new BadRequestError(`Unknown mcp_server_id: '${id}'`);
    }

    return {
      name, description, isolated,
      plugin_refs: JSON.stringify(pluginRefs),
      mcp_server_ids: JSON.stringify(mcpServerIds),
      base_system_prompt: basePrompt,
      setting_sources: settingSources,
      min_claude_version: minClaudeVersion,
    };
  }

  function createPreset(data) {
    const normalized = normalizeInputs(data);
    // Unique name check (reuses table UNIQUE constraint, but surface 409 with friendly message)
    const existing = stmts.getByName.get(normalized.name);
    if (existing) throw new ConflictError(`Preset name already exists: ${normalized.name}`);
    const id = `wp_${crypto.randomUUID().slice(0, 12)}`;
    try {
      stmts.insert.run({ id, ...normalized });
    } catch (err) {
      if (String(err.message).includes('UNIQUE')) {
        throw new ConflictError(`Preset name already exists: ${normalized.name}`);
      }
      throw err;
    }
    return rowToPreset(stmts.getById.get(id));
  }

  function getPreset(id) {
    const row = stmts.getById.get(id);
    if (!row) throw new NotFoundError(`Preset not found: ${id}`);
    return rowToPreset(row);
  }

  function listPresets() {
    return stmts.listAll.all().map(rowToPreset);
  }

  function updatePreset(id, data) {
    const existing = stmts.getById.get(id);
    if (!existing) throw new NotFoundError(`Preset not found: ${id}`);
    const merged = {
      name: data.name != null ? data.name : existing.name,
      description: 'description' in data ? data.description : existing.description,
      isolated: 'isolated' in data ? data.isolated : !!existing.isolated,
      plugin_refs: 'plugin_refs' in data ? data.plugin_refs : safeParseArray(existing.plugin_refs),
      mcp_server_ids: 'mcp_server_ids' in data ? data.mcp_server_ids : safeParseArray(existing.mcp_server_ids),
      base_system_prompt: 'base_system_prompt' in data ? data.base_system_prompt : existing.base_system_prompt,
      setting_sources: 'setting_sources' in data ? data.setting_sources : existing.setting_sources,
      min_claude_version: 'min_claude_version' in data ? data.min_claude_version : existing.min_claude_version,
    };
    const normalized = normalizeInputs(merged);
    // Name uniqueness across other rows
    const byName = stmts.getByName.get(normalized.name);
    if (byName && byName.id !== id) {
      throw new ConflictError(`Preset name already exists: ${normalized.name}`);
    }
    // Bust manifest cache entries for plugin_refs that may have changed
    const prevRefs = safeParseArray(existing.plugin_refs);
    const newRefs = JSON.parse(normalized.plugin_refs);
    const changed = new Set([...prevRefs, ...newRefs]);
    for (const ref of changed) manifestCache.delete(ref);

    stmts.update.run({ id, ...normalized });
    return rowToPreset(stmts.getById.get(id));
  }

  /**
   * Delete preset + app-level cascade of tasks.preferred_preset_id → NULL.
   * Wrapped in a single transaction. run_preset_snapshots is intentionally
   * NOT touched — historical forensic data survives preset deletion.
   */
  function deletePreset(id) {
    const existing = stmts.getById.get(id);
    if (!existing) throw new NotFoundError(`Preset not found: ${id}`);
    const tx = db.transaction(() => {
      stmts.nullTaskRefs.run(id);
      stmts.delete.run(id);
    });
    tx();
    for (const ref of safeParseArray(existing.plugin_refs)) manifestCache.delete(ref);
    return rowToPreset(existing);
  }

  /**
   * Return valid plugin directories present under pluginsRoot that have a
   * parseable `plugin.json`. Directories whose manifest is missing, unparseable,
   * or not a plain object are skipped and reported in `warnings`.
   *
   * Returns `{ plugin_refs: [...], warnings: [{ dir, reason }] }`.
   * Used by UI dropdowns and GET /api/worker-presets/plugin-refs.
   */
  function listPluginRefs() {
    let entries;
    try {
      entries = fs.readdirSync(pluginsRoot, { withFileTypes: true });
    } catch (err) {
      if (err.code === 'ENOENT') return { plugin_refs: [], warnings: [] };
      throw err;
    }
    const out = [];
    const warnings = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name.startsWith('.')) continue;
      const manifestPath = path.join(pluginsRoot, entry.name, 'plugin.json');
      // plugin.json must exist and be a regular file
      try {
        if (!fs.statSync(manifestPath).isFile()) continue;
      } catch { continue; }
      // plugin.json must parse as a plain object
      let meta = null;
      let parseError = null;
      try {
        const raw = fs.readFileSync(manifestPath, 'utf8');
        const parsed = JSON.parse(raw);
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
          parseError = 'plugin.json must be a JSON object';
        } else {
          meta = parsed;
        }
      } catch (err) {
        parseError = err.message;
      }
      if (parseError !== null) {
        console.warn(`[preset] skipped malformed plugin.json at ${manifestPath}: ${parseError}`);
        warnings.push({ dir: entry.name, reason: parseError });
        continue;
      }
      out.push({
        name: entry.name,
        description: meta?.description || null,
        version: meta?.version || null,
      });
    }
    out.sort((a, b) => a.name.localeCompare(b.name));
    return { plugin_refs: out, warnings };
  }

  /**
   * Build a content snapshot of a preset. Path namespace: <pluginRef>/<relpath>
   * per spec §6.5. Plugin files are cached in manifestCache by (mtime, size).
   *
   * Returns `{ hash, snapshotJson, fileHashes }`.
   */
  function buildSnapshot(preset) {
    if (!preset) throw new BadRequestError('buildSnapshot requires a preset');
    const pluginRefs = Array.isArray(preset.plugin_refs)
      ? preset.plugin_refs
      : safeParseArray(preset.plugin_refs);
    const snapshotCore = {
      name: preset.name,
      isolated: !!preset.isolated,
      plugin_refs: pluginRefs,
      mcp_server_ids: Array.isArray(preset.mcp_server_ids)
        ? preset.mcp_server_ids
        : safeParseArray(preset.mcp_server_ids),
      base_system_prompt: preset.base_system_prompt || null,
      setting_sources: preset.setting_sources || '',
      min_claude_version: preset.min_claude_version || null,
    };
    const snapshotJson = JSON.stringify(snapshotCore);

    const fileHashes = [];
    for (const ref of pluginRefs) {
      if (!pluginDirExists(ref)) {
        throw new BadRequestError(`Plugin ref no longer available: '${ref}'. Update preset or restore the plugin directory.`);
      }
      const absDir = path.join(pluginsRoot, ref);
      const cached = manifestCache.get(ref);
      const manifest = buildManifest(absDir, cached);
      manifestCache.set(ref, manifest);
      for (const entry of manifest.files) {
        fileHashes.push({ path: `${ref}/${entry.path}`, sha256: entry.sha256 });
      }
    }
    fileHashes.sort((a, b) => a.path.localeCompare(b.path));

    const combined = snapshotJson + JSON.stringify(fileHashes);
    const hash = crypto.createHash('sha256').update(combined).digest('hex');
    return { hash, snapshotJson, fileHashes };
  }

  /**
   * Persist a snapshot row for a given run. Idempotent per (runId) — the
   * caller is expected to only invoke this once per run.
   */
  function persistSnapshot(runId, preset, snapshot) {
    stmts.insertSnapshot.run({
      run_id: runId,
      preset_id: preset.id,
      preset_snapshot_hash: snapshot.hash,
      snapshot_json: snapshot.snapshotJson,
      file_hashes: JSON.stringify(snapshot.fileHashes),
    });
  }

  function getSnapshotForRun(runId) {
    const row = stmts.getSnapshotByRunId.get(runId);
    if (!row) return null;
    return {
      ...row,
      file_hashes: safeParseArray(row.file_hashes),
    };
  }

  /**
   * Resolve a preset for a worker spawn. Adapter-specific wiring is NOT
   * applied here (Phase 10C). This returns the canonical pieces the caller
   * can combine with skill-pack output, project MCP, and auth env.
   *
   * @param {Object} params
   * @param {string} params.presetId  — preset id (required)
   * @param {'claude'|'codex'|'opencode'} params.adapter
   * @returns {{
   *   preset, systemPrompt, mcpConfig, pluginDirs, isolated,
   *   snapshot, warnings
   * }}
   */
  function resolveForSpawn({ presetId, adapter }) {
    const preset = getPreset(presetId);
    const warnings = [];

    // Tier 1 MCP: resolve mcp_server_templates → config object
    const templates = [];
    for (const id of preset.mcp_server_ids) {
      const tpl = stmts.getMcpTemplateById.get(id);
      if (!tpl) {
        warnings.push({ type: 'preset:mcp_template_missing', template_id: id });
        continue;
      }
      templates.push(tpl);
    }
    const mcpConfig = templates.length > 0 ? buildMcpConfigFromTemplates(templates) : null;

    // Tier 2 (isolated) gating — Claude only
    let isolated = !!preset.isolated;
    const pluginDirs = [];
    if (isolated) {
      if (adapter !== 'claude') {
        warnings.push({
          type: 'preset:tier2_skipped',
          adapter,
          reason: 'Tier 2 is Claude-only',
        });
        isolated = false;
      } else {
        for (const ref of preset.plugin_refs) {
          const absDir = path.join(pluginsRoot, ref);
          if (!pluginDirExists(ref)) {
            throw new BadRequestError(`Plugin ref no longer available: '${ref}'. Update preset or restore the plugin directory.`);
          }
          pluginDirs.push(absDir);
        }
      }
    }

    // Snapshot (always built — provides forensic record even for Tier 1)
    const snapshot = buildSnapshot(preset);

    return {
      preset,
      systemPrompt: preset.base_system_prompt || '',
      mcpConfig,
      pluginDirs,
      isolated,
      settingSources: preset.setting_sources || '',
      minClaudeVersion: preset.min_claude_version || null,
      snapshot,
      warnings,
    };
  }

  return {
    createPreset,
    getPreset,
    listPresets,
    updatePreset,
    deletePreset,
    listPluginRefs,
    buildSnapshot,
    persistSnapshot,
    getSnapshotForRun,
    resolveForSpawn,
    // Pure helpers exposed for Phase 10C + tests
    mergeMcp3,
    resolvePromptChain,
    compareSemver,
    // Introspection (tests)
    _pluginsRoot: pluginsRoot,
  };
}

module.exports = {
  createPresetService,
  mergeMcp3,
  resolvePromptChain,
  compareSemver,
  MAX_PROMPT_BYTES,
  PROMPT_SEPARATOR,
};
