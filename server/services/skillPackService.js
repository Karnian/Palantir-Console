const crypto = require('node:crypto');
const { BadRequestError, NotFoundError } = require('../utils/errors');

// Default MCP server templates — seed-only in v1 (no API CRUD)
const DEFAULT_MCP_TEMPLATES = [
  {
    id: 'tpl_playwright',
    alias: 'playwright',
    command: 'npx',
    args: JSON.stringify(['-y', '@anthropic-ai/mcp-server-playwright']),
    allowed_env_keys: JSON.stringify(['BROWSER', 'HEADLESS']),
    description: 'Playwright browser automation MCP server',
  },
  {
    id: 'tpl_filesystem',
    alias: 'filesystem',
    command: 'npx',
    args: JSON.stringify(['-y', '@anthropic-ai/mcp-server-filesystem']),
    allowed_env_keys: JSON.stringify(['ALLOWED_DIRECTORIES']),
    description: 'Filesystem access MCP server',
  },
];

// Tier 2: Global hard denylist — always rejected regardless of per-template allowlist
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
  return ENV_HARD_DENYLIST_PATTERNS.some(pattern => pattern.test(key));
}

function estimateTokens(text) {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}

function validateMcpServersJson(mcpServers) {
  if (!mcpServers) return null;
  if (typeof mcpServers === 'string') {
    try { mcpServers = JSON.parse(mcpServers); } catch { throw new BadRequestError('mcp_servers must be valid JSON'); }
  }
  if (typeof mcpServers !== 'object' || Array.isArray(mcpServers)) {
    throw new BadRequestError('mcp_servers must be an object keyed by alias');
  }
  for (const [alias, config] of Object.entries(mcpServers)) {
    if (typeof alias !== 'string' || !alias) throw new BadRequestError('mcp_servers alias must be a non-empty string');
    if (config && typeof config !== 'object') throw new BadRequestError(`mcp_servers["${alias}"] must be an object or null`);
  }
  return JSON.stringify(mcpServers);
}

function validateChecklist(checklist) {
  if (!checklist) return null;
  if (typeof checklist === 'string') {
    try { checklist = JSON.parse(checklist); } catch { throw new BadRequestError('checklist must be valid JSON array'); }
  }
  if (!Array.isArray(checklist)) throw new BadRequestError('checklist must be an array of strings');
  for (const item of checklist) {
    if (typeof item !== 'string') throw new BadRequestError('checklist items must be strings');
  }
  return JSON.stringify(checklist);
}

function createSkillPackService(db) {
  // Seed default MCP templates on construction
  const upsertTemplate = db.prepare(`
    INSERT INTO mcp_server_templates (id, alias, command, args, allowed_env_keys, description)
    VALUES (@id, @alias, @command, @args, @allowed_env_keys, @description)
    ON CONFLICT(id) DO UPDATE SET
      alias = excluded.alias,
      command = excluded.command,
      args = excluded.args,
      allowed_env_keys = excluded.allowed_env_keys,
      description = excluded.description
  `);
  const seedTemplates = db.transaction(() => {
    for (const tpl of DEFAULT_MCP_TEMPLATES) {
      upsertTemplate.run(tpl);
    }
  });
  seedTemplates();

  // Prepared statements
  const stmts = {
    // Skill Pack CRUD
    getById: db.prepare('SELECT * FROM skill_packs WHERE id = ?'),
    listAll: db.prepare('SELECT * FROM skill_packs ORDER BY priority ASC, name ASC'),
    listByScope: db.prepare('SELECT * FROM skill_packs WHERE scope = ? ORDER BY priority ASC, name ASC'),
    listByProject: db.prepare('SELECT * FROM skill_packs WHERE scope = ? AND project_id = ? ORDER BY priority ASC, name ASC'),
    listForProjectView: db.prepare(`
      SELECT * FROM skill_packs
      WHERE scope = 'global'
         OR (scope = 'project' AND project_id = ?)
      ORDER BY priority ASC, name ASC
    `),
    insert: db.prepare(`
      INSERT INTO skill_packs (
        id, name, description, scope, project_id, icon, color,
        prompt_full, prompt_compact, estimated_tokens, estimated_tokens_compact,
        mcp_servers, conflict_policy, checklist, inject_checklist, priority
      ) VALUES (
        @id, @name, @description, @scope, @project_id, @icon, @color,
        @prompt_full, @prompt_compact, @estimated_tokens, @estimated_tokens_compact,
        @mcp_servers, @conflict_policy, @checklist, @inject_checklist, @priority
      )
    `),
    delete: db.prepare('DELETE FROM skill_packs WHERE id = ?'),

    // MCP templates
    getTemplateByAlias: db.prepare('SELECT * FROM mcp_server_templates WHERE alias = ?'),
    listTemplates: db.prepare('SELECT * FROM mcp_server_templates ORDER BY alias ASC'),

    // Project bindings
    listProjectBindings: db.prepare(`
      SELECT psp.*, sp.name AS skill_pack_name, sp.description AS skill_pack_description,
             sp.scope, sp.project_id AS skill_pack_project_id
      FROM project_skill_packs psp
      JOIN skill_packs sp ON sp.id = psp.skill_pack_id
      WHERE psp.project_id = ?
      ORDER BY psp.priority ASC
    `),
    getProjectBinding: db.prepare('SELECT * FROM project_skill_packs WHERE project_id = ? AND skill_pack_id = ?'),
    insertProjectBinding: db.prepare(`
      INSERT INTO project_skill_packs (project_id, skill_pack_id, priority, auto_apply)
      VALUES (@project_id, @skill_pack_id, @priority, @auto_apply)
    `),
    updateProjectBinding: db.prepare(`
      UPDATE project_skill_packs SET priority = @priority, auto_apply = @auto_apply
      WHERE project_id = @project_id AND skill_pack_id = @skill_pack_id
    `),
    deleteProjectBinding: db.prepare('DELETE FROM project_skill_packs WHERE project_id = ? AND skill_pack_id = ?'),

    // Task bindings
    listTaskBindings: db.prepare(`
      SELECT tsp.*, sp.name AS skill_pack_name, sp.description AS skill_pack_description,
             sp.scope, sp.project_id AS skill_pack_project_id
      FROM task_skill_packs tsp
      JOIN skill_packs sp ON sp.id = tsp.skill_pack_id
      WHERE tsp.task_id = ?
      ORDER BY tsp.priority ASC
    `),
    getTaskBinding: db.prepare('SELECT * FROM task_skill_packs WHERE task_id = ? AND skill_pack_id = ?'),
    insertTaskBinding: db.prepare(`
      INSERT INTO task_skill_packs (task_id, skill_pack_id, priority, pinned_by, excluded)
      VALUES (@task_id, @skill_pack_id, @priority, @pinned_by, @excluded)
    `),
    updateTaskBinding: db.prepare(`
      UPDATE task_skill_packs SET priority = @priority, excluded = @excluded, pinned_by = @pinned_by
      WHERE task_id = @task_id AND skill_pack_id = @skill_pack_id
    `),
    deleteTaskBinding: db.prepare('DELETE FROM task_skill_packs WHERE task_id = ? AND skill_pack_id = ?'),

    // Run snapshots
    listRunSnapshots: db.prepare(`
      SELECT * FROM run_skill_packs WHERE run_id = ? ORDER BY applied_order ASC
    `),
  };

  // ─── Skill Pack CRUD ───

  function createSkillPack(data) {
    const {
      name, description, scope = 'global', project_id,
      icon, color, prompt_full, prompt_compact,
      mcp_servers, conflict_policy = 'fail',
      checklist, inject_checklist = 0, priority = 100,
    } = data;

    if (!name || typeof name !== 'string' || !name.trim()) {
      throw new BadRequestError('Skill pack name is required');
    }
    if (scope === 'project' && !project_id) {
      throw new BadRequestError('project_id is required for project-scope skill packs');
    }
    if (scope === 'global' && project_id) {
      throw new BadRequestError('project_id must be null for global-scope skill packs');
    }
    if (conflict_policy && !['fail', 'warn'].includes(conflict_policy)) {
      throw new BadRequestError('conflict_policy must be "fail" or "warn"');
    }

    const validatedMcpServers = validateMcpServersJson(mcp_servers);
    const validatedChecklist = validateChecklist(checklist);

    // Validate MCP server aliases exist and env overrides are allowed
    if (validatedMcpServers) {
      validateMcpEnvOverrides(JSON.parse(validatedMcpServers));
    }

    const id = `sp_${crypto.randomUUID().slice(0, 12)}`;

    stmts.insert.run({
      id,
      name: name.trim(),
      description: description || null,
      scope,
      project_id: project_id || null,
      icon: icon || null,
      color: color || null,
      prompt_full: prompt_full || null,
      prompt_compact: prompt_compact || null,
      estimated_tokens: estimateTokens(prompt_full),
      estimated_tokens_compact: estimateTokens(prompt_compact),
      mcp_servers: validatedMcpServers,
      conflict_policy,
      checklist: validatedChecklist,
      inject_checklist: inject_checklist ? 1 : 0,
      priority: typeof priority === 'number' ? priority : 100,
    });

    return stmts.getById.get(id);
  }

  function getSkillPack(id) {
    const pack = stmts.getById.get(id);
    if (!pack) throw new NotFoundError(`Skill pack not found: ${id}`);
    return pack;
  }

  function listSkillPacks({ scope, project_id } = {}) {
    if (project_id) {
      // Shadow rule: return project-scope packs + global packs, with project-scope
      // packs replacing same-name global packs
      const all = stmts.listForProjectView.all(project_id);
      const byName = new Map();
      for (const pack of all) {
        const existing = byName.get(pack.name);
        if (!existing || pack.scope === 'project') {
          byName.set(pack.name, pack);
        }
      }
      return [...byName.values()].sort((a, b) => a.priority - b.priority || a.name.localeCompare(b.name));
    }
    if (scope) {
      return stmts.listByScope.all(scope);
    }
    return stmts.listAll.all();
  }

  function updateSkillPack(id, data) {
    const existing = getSkillPack(id);

    // Ownership check for project-scope
    if (existing.scope === 'project' && data.project_id && data.project_id !== existing.project_id) {
      throw new BadRequestError('Cannot change project_id of a project-scope skill pack');
    }

    const fields = [];
    const params = { id };

    const allowedFields = [
      'name', 'description', 'icon', 'color',
      'prompt_full', 'prompt_compact',
      'mcp_servers', 'conflict_policy',
      'checklist', 'inject_checklist', 'priority',
    ];

    for (const field of allowedFields) {
      if (data[field] !== undefined) {
        let value = data[field];

        if (field === 'mcp_servers') {
          value = validateMcpServersJson(value);
          if (value) validateMcpEnvOverrides(JSON.parse(value));
        } else if (field === 'checklist') {
          value = validateChecklist(value);
        } else if (field === 'conflict_policy') {
          if (!['fail', 'warn'].includes(value)) throw new BadRequestError('conflict_policy must be "fail" or "warn"');
        } else if (field === 'inject_checklist') {
          value = value ? 1 : 0;
        } else if (field === 'name') {
          if (!value || typeof value !== 'string' || !value.trim()) throw new BadRequestError('name cannot be empty');
          value = value.trim();
        }

        fields.push(`${field} = @${field}`);
        params[field] = value ?? null;
      }
    }

    // Recompute estimated tokens if prompt changed
    if (data.prompt_full !== undefined) {
      fields.push('estimated_tokens = @estimated_tokens');
      params.estimated_tokens = estimateTokens(data.prompt_full);
    }
    if (data.prompt_compact !== undefined) {
      fields.push('estimated_tokens_compact = @estimated_tokens_compact');
      params.estimated_tokens_compact = estimateTokens(data.prompt_compact);
    }

    if (fields.length === 0) return existing;

    fields.push("updated_at = datetime('now')");
    db.prepare(`UPDATE skill_packs SET ${fields.join(', ')} WHERE id = @id`).run(params);
    return stmts.getById.get(id);
  }

  function deleteSkillPack(id) {
    const existing = getSkillPack(id);
    stmts.delete.run(id);
    return existing;
  }

  // ─── MCP Templates ───

  function listMcpTemplates() {
    return stmts.listTemplates.all();
  }

  function getMcpTemplate(alias) {
    return stmts.getTemplateByAlias.get(alias);
  }

  // ─── MCP Env Validation ───

  function validateMcpEnvOverrides(mcpServersObj) {
    if (!mcpServersObj) return;
    for (const [alias, config] of Object.entries(mcpServersObj)) {
      const template = stmts.getTemplateByAlias.get(alias);
      if (!template) {
        throw new BadRequestError(`Unknown MCP server template alias: "${alias}"`);
      }
      const envOverrides = config?.env_overrides;
      if (!envOverrides || typeof envOverrides !== 'object') continue;

      const allowedKeys = template.allowed_env_keys ? JSON.parse(template.allowed_env_keys) : [];

      for (const key of Object.keys(envOverrides)) {
        // Tier 2: global hard denylist
        if (isEnvKeyDenied(key)) {
          throw new BadRequestError(`Environment variable "${key}" is blocked by security policy`);
        }
        // Tier 1: per-template positive allowlist
        if (!allowedKeys.includes(key)) {
          throw new BadRequestError(`Environment variable "${key}" is not allowed for MCP template "${alias}" (allowed: ${allowedKeys.join(', ') || 'none'})`);
        }
      }
    }
  }

  /**
   * Resolve MCP server aliases to full configs.
   * Returns { servers: { alias: { command, args, env } }, warnings: [] }
   */
  function resolveMcpServers(mcpServersJson) {
    if (!mcpServersJson) return { servers: {}, warnings: [] };
    const mcpServers = typeof mcpServersJson === 'string' ? JSON.parse(mcpServersJson) : mcpServersJson;
    const servers = {};
    const warnings = [];

    for (const [alias, config] of Object.entries(mcpServers)) {
      const template = stmts.getTemplateByAlias.get(alias);
      if (!template) {
        warnings.push(`MCP template "${alias}" not found — skipped`);
        continue;
      }

      const args = template.args ? JSON.parse(template.args) : [];
      const env = {};
      const envOverrides = config?.env_overrides;
      if (envOverrides && typeof envOverrides === 'object') {
        for (const [k, v] of Object.entries(envOverrides)) {
          env[k] = String(v);
        }
      }

      servers[alias] = {
        command: template.command,
        args,
        ...(Object.keys(env).length > 0 ? { env } : {}),
      };
    }

    return { servers, warnings };
  }

  // ─── Project Bindings ───

  function listProjectBindings(projectId) {
    return stmts.listProjectBindings.all(projectId);
  }

  function bindToProject(projectId, { skill_pack_id, priority = 100, auto_apply = 0 }) {
    if (!skill_pack_id) throw new BadRequestError('skill_pack_id is required');
    const pack = getSkillPack(skill_pack_id);

    // Cross-project check (service-layer, in addition to DB trigger)
    if (pack.scope === 'project' && pack.project_id !== projectId) {
      throw new BadRequestError('Cannot bind project-scope skill pack to different project');
    }

    // Check for existing binding
    const existing = stmts.getProjectBinding.get(projectId, skill_pack_id);
    if (existing) {
      throw new BadRequestError('Skill pack already bound to this project');
    }

    stmts.insertProjectBinding.run({
      project_id: projectId,
      skill_pack_id,
      priority: typeof priority === 'number' ? priority : 100,
      auto_apply: auto_apply ? 1 : 0,
    });

    return stmts.getProjectBinding.get(projectId, skill_pack_id);
  }

  function updateProjectBinding(projectId, packId, { priority, auto_apply }) {
    const existing = stmts.getProjectBinding.get(projectId, packId);
    if (!existing) throw new NotFoundError('Project-skill pack binding not found');

    stmts.updateProjectBinding.run({
      project_id: projectId,
      skill_pack_id: packId,
      priority: priority !== undefined ? priority : existing.priority,
      auto_apply: auto_apply !== undefined ? (auto_apply ? 1 : 0) : existing.auto_apply,
    });

    return stmts.getProjectBinding.get(projectId, packId);
  }

  function unbindFromProject(projectId, packId) {
    const existing = stmts.getProjectBinding.get(projectId, packId);
    if (!existing) throw new NotFoundError('Project-skill pack binding not found');
    stmts.deleteProjectBinding.run(projectId, packId);
    return existing;
  }

  // ─── Task Bindings ───

  function listTaskBindings(taskId) {
    return stmts.listTaskBindings.all(taskId);
  }

  function bindToTask(taskId, { skill_pack_id, priority = 100, excluded = 0, callerType = 'user' }) {
    if (!skill_pack_id) throw new BadRequestError('skill_pack_id is required');
    getSkillPack(skill_pack_id); // verify exists

    const pinned_by = callerType === 'pm' ? 'pm' : 'user';

    // Check for existing binding
    const existing = stmts.getTaskBinding.get(taskId, skill_pack_id);
    if (existing) {
      // If existing is user-excluded, PM cannot override (Lock-in #4)
      if (existing.excluded === 1 && existing.pinned_by === 'user' && callerType === 'pm') {
        throw new BadRequestError('Cannot override user-excluded skill pack binding');
      }
      // Update existing binding — pinned_by tracks the last writer
      stmts.updateTaskBinding.run({
        task_id: taskId,
        skill_pack_id,
        priority: typeof priority === 'number' ? priority : existing.priority,
        excluded: excluded ? 1 : 0,
        pinned_by,
      });
      return stmts.getTaskBinding.get(taskId, skill_pack_id);
    }

    stmts.insertTaskBinding.run({
      task_id: taskId,
      skill_pack_id,
      priority: typeof priority === 'number' ? priority : 100,
      pinned_by,
      excluded: excluded ? 1 : 0,
    });

    return stmts.getTaskBinding.get(taskId, skill_pack_id);
  }

  function unbindFromTask(taskId, packId, { callerType = 'user' } = {}) {
    const existing = stmts.getTaskBinding.get(taskId, packId);
    if (!existing) throw new NotFoundError('Task-skill pack binding not found');

    // Lock-in #4: PM cannot delete user-excluded bindings
    if (existing.excluded === 1 && existing.pinned_by === 'user' && callerType === 'pm') {
      throw new BadRequestError('Cannot remove user-excluded skill pack binding via PM');
    }

    stmts.deleteTaskBinding.run(taskId, packId);
    return existing;
  }

  // ─── resolveForRun ───

  /**
   * Resolve the effective skill pack set for a run.
   * Spec §12.1: Phase A→E pipeline.
   *
   * @param {Object} deps - { taskService, agentProfileService, projectService }
   * @param {Object} params - { taskId, explicitPackIds?, agentProfileId }
   * @returns {{ promptSections[], mcpConfig, checklist[], appliedPacks[], warnings[] }}
   */
  function resolveForRun(deps, { taskId, explicitPackIds, agentProfileId }) {
    const task = deps.taskService.getTask(taskId);
    const profile = deps.agentProfileService.getProfile(agentProfileId);
    const warnings = [];

    // Phase A: Input validation — explicitPackIds cross-project check
    if (explicitPackIds && explicitPackIds.length > 0) {
      for (const packId of explicitPackIds) {
        const pack = stmts.getById.get(packId);
        if (!pack) throw new BadRequestError(`Skill pack not found: ${packId}`);
        if (pack.scope === 'project') {
          if (!task.project_id || pack.project_id !== task.project_id) {
            throw new BadRequestError(`Cannot apply project-scope skill pack "${pack.name}" to task in different/no project`);
          }
        }
      }
    }

    // Phase B: Collection
    const packMap = new Map(); // packId → { pack, source, bindingPriority }

    // B1: project auto_apply packs
    if (task.project_id) {
      const projectBindings = stmts.listProjectBindings.all(task.project_id);
      for (const binding of projectBindings) {
        if (!binding.auto_apply) continue;
        const pack = stmts.getById.get(binding.skill_pack_id);
        if (!pack) continue;
        packMap.set(pack.id, { pack, source: 'project', bindingPriority: binding.priority });
      }
    }

    // B2: explicitPackIds (per-run ephemeral, not persisted)
    if (explicitPackIds && explicitPackIds.length > 0) {
      for (const packId of explicitPackIds) {
        if (packMap.has(packId)) continue; // dedup
        const pack = stmts.getById.get(packId);
        if (!pack) continue;
        packMap.set(pack.id, { pack, source: 'explicit', bindingPriority: pack.priority });
      }
    }

    // B3: task pinned packs
    const taskBindings = stmts.listTaskBindings.all(taskId);
    const taskBindingMap = new Map();
    for (const binding of taskBindings) {
      taskBindingMap.set(binding.skill_pack_id, binding);
      if (binding.excluded) continue; // will handle in Phase C
      if (packMap.has(binding.skill_pack_id)) {
        // Update source to task for priority resolution
        const existing = packMap.get(binding.skill_pack_id);
        existing.source = 'task';
        existing.bindingPriority = binding.priority;
        continue;
      }
      const pack = stmts.getById.get(binding.skill_pack_id);
      if (!pack) continue;
      packMap.set(pack.id, { pack, source: 'task', bindingPriority: binding.priority });
    }

    // Shadow rule (after all collection): project-scope packs shadow same-name globals
    {
      const nameGroups = new Map();
      for (const [id, entry] of packMap) {
        const name = entry.pack.name;
        if (!nameGroups.has(name)) nameGroups.set(name, []);
        nameGroups.get(name).push(id);
      }
      for (const [, ids] of nameGroups) {
        if (ids.length <= 1) continue;
        if (ids.some(id => packMap.get(id).pack.scope === 'project')) {
          for (const id of ids) {
            if (packMap.get(id).pack.scope === 'global') packMap.delete(id);
          }
        }
      }
    }

    // Phase C: Effective set validation

    // C4: Cross-project isolation (full effective set)
    for (const [id, entry] of packMap) {
      if (entry.pack.scope === 'project' && task.project_id && entry.pack.project_id !== task.project_id) {
        packMap.delete(id);
        warnings.push({ type: 'skill_pack:cross_project_violation', packId: id, name: entry.pack.name });
      }
    }

    // C5: Excluded filter
    for (const [id, entry] of packMap) {
      const binding = taskBindingMap.get(id);
      if (!binding || !binding.excluded) continue;

      if (binding.pinned_by === 'user') {
        // Lock-in #4: user-excluded → always removed
        packMap.delete(id);
      } else {
        // PM-excluded: can be overridden by explicitPackIds
        if (explicitPackIds && explicitPackIds.includes(id)) {
          // Keep — explicit override of PM exclusion
        } else {
          packMap.delete(id);
        }
      }
    }

    // Phase D: Adapter gating
    const isClaude = (profile.command || '').includes('claude');
    if (!isClaude) {
      if (packMap.size === 0) {
        return { promptSections: [], mcpConfig: null, checklist: [], appliedPacks: [], warnings };
      }
      // Non-Claude workers: skip prompt/MCP planes
      const appliedPacks = [...packMap.values()].map(e => ({
        id: e.pack.id, name: e.pack.name, skippedReason: 'adapter_unsupported',
      }));
      warnings.push({ type: 'skill_pack:adapter_unsupported', agent: profile.name, count: packMap.size });

      // Only acceptance overlay (checklist) survives
      const checklist = [];
      for (const entry of packMap.values()) {
        if (entry.pack.checklist) {
          try {
            const items = JSON.parse(entry.pack.checklist);
            checklist.push(...items);
          } catch { /* skip */ }
        }
      }

      return { promptSections: [], mcpConfig: null, checklist: deduplicateChecklist(checklist), appliedPacks, warnings };
    }

    // Phase E: Synthesis (Claude workers only)

    // E7: effective priority — task binding > project binding > pack default
    const sorted = [...packMap.values()].map(entry => {
      const taskBinding = taskBindingMap.get(entry.pack.id);
      const effectivePriority = taskBinding ? taskBinding.priority
        : entry.source === 'project' ? entry.bindingPriority
        : entry.pack.priority;
      return { ...entry, effectivePriority };
    });

    // E8: sort by effective priority ascending
    sorted.sort((a, b) => a.effectivePriority - b.effectivePriority);

    // E9: Token budget
    const TOKEN_BUDGET = Number(process.env.SKILL_PACK_TOKEN_BUDGET || 4000);
    let totalTokens = 0;
    const resolvedPacks = [];

    // First pass: compute tokens with full mode
    for (const entry of sorted) {
      const fullTokens = estimateTokens(entry.pack.prompt_full);
      const compactTokens = estimateTokens(entry.pack.prompt_compact);
      resolvedPacks.push({
        ...entry,
        fullTokens,
        compactTokens,
        mode: 'full',
        promptText: entry.pack.prompt_full,
      });
      totalTokens += fullTokens;
    }

    // Compact pass: if over budget, compact from lowest priority first
    if (totalTokens > TOKEN_BUDGET) {
      // Sort by priority ASC (lowest first), tie-break by largest tokens first
      const compactOrder = [...resolvedPacks].sort((a, b) => {
        if (a.effectivePriority !== b.effectivePriority) return a.effectivePriority - b.effectivePriority;
        return b.fullTokens - a.fullTokens;
      });

      for (const entry of compactOrder) {
        if (totalTokens <= TOKEN_BUDGET) break;
        if (!entry.pack.prompt_compact) continue; // can't compact
        const saved = entry.fullTokens - entry.compactTokens;
        entry.mode = 'compact';
        entry.promptText = entry.pack.prompt_compact;
        totalTokens -= saved;
      }

      if (totalTokens > TOKEN_BUDGET) {
        throw new BadRequestError(
          `Skill pack token budget exceeded (${totalTokens}/${TOKEN_BUDGET}). Remove packs or use compact mode.`
        );
      }
    }

    // E10: MCP alias resolution + conflict check
    const allMcpServers = {};
    const mcpConflicts = new Map(); // alias → [packNames]
    const perPackMcp = new Map(); // packId → resolved servers obj

    for (const entry of resolvedPacks) {
      if (!entry.pack.mcp_servers) {
        perPackMcp.set(entry.pack.id, null);
        continue;
      }
      const { servers, warnings: resolveWarnings } = resolveMcpServers(entry.pack.mcp_servers);
      perPackMcp.set(entry.pack.id, servers);
      for (const w of resolveWarnings) warnings.push({ type: 'skill_pack:mcp_resolve_warning', message: w });

      for (const [alias, config] of Object.entries(servers)) {
        if (allMcpServers[alias]) {
          if (!mcpConflicts.has(alias)) {
            mcpConflicts.set(alias, [allMcpServers[alias]._sourcePack]);
          }
          mcpConflicts.get(alias).push(entry.pack.name);
        } else {
          allMcpServers[alias] = { ...config, _sourcePack: entry.pack.name, _sourcePolicy: entry.pack.conflict_policy };
        }
      }
    }

    // Handle inter-pack conflicts
    for (const [alias, packs] of mcpConflicts) {
      const allEntries = resolvedPacks.filter(e => {
        const servers = perPackMcp.get(e.pack.id);
        return servers && servers[alias];
      });
      const anyFail = allEntries.some(e => e.pack.conflict_policy === 'fail');
      if (anyFail) {
        throw new BadRequestError(
          `MCP server conflict on alias "${alias}" between packs: ${packs.join(', ')}. One or more packs have conflict_policy=fail.`
        );
      }
      // All warn: use highest priority pack's config
      warnings.push({ type: 'skill_pack:mcp_conflict_warn', alias, packs });
      // The allMcpServers already has the first pack's config; replace with highest priority
      // Lowest number = highest priority; use applied_order as tie-breaker
      const highestPriority = allEntries.sort((a, b) =>
        a.effectivePriority !== b.effectivePriority
          ? a.effectivePriority - b.effectivePriority
          : (a.order ?? 0) - (b.order ?? 0)
      )[0];
      const servers = perPackMcp.get(highestPriority.pack.id);
      if (servers && servers[alias]) {
        allMcpServers[alias] = { ...servers[alias], _sourcePack: highestPriority.pack.name, _sourcePolicy: highestPriority.pack.conflict_policy };
      }
    }

    // Clean up internal markers from MCP config
    const cleanMcpServers = {};
    for (const [alias, config] of Object.entries(allMcpServers)) {
      const { _sourcePack, _sourcePolicy, ...clean } = config;
      cleanMcpServers[alias] = clean;
    }

    // E11: Build prompt sections
    const promptSections = [];
    for (let i = 0; i < resolvedPacks.length; i++) {
      const entry = resolvedPacks[i];
      if (!entry.promptText) continue;
      promptSections.push({
        name: entry.pack.name,
        text: entry.promptText,
        mode: entry.mode,
        priority: entry.effectivePriority,
        order: i,
      });
    }

    // Build checklist
    const checklist = [];
    for (const entry of resolvedPacks) {
      if (entry.pack.checklist) {
        try { checklist.push(...JSON.parse(entry.pack.checklist)); } catch { /* skip */ }
      }
    }

    // Build appliedPacks for snapshot recording
    const appliedPacks = resolvedPacks.map((entry, i) => ({
      id: entry.pack.id,
      name: entry.pack.name,
      promptText: entry.promptText || null,
      promptHash: entry.promptText ? require('node:crypto').createHash('sha256').update(entry.promptText).digest('hex') : null,
      mcpConfigSnapshot: perPackMcp.get(entry.pack.id) ? JSON.stringify(perPackMcp.get(entry.pack.id)) : null,
      checklistSnapshot: entry.pack.checklist || null,
      mode: entry.mode,
      order: i,
      effectivePriority: entry.effectivePriority,
    }));

    return {
      promptSections,
      mcpConfig: Object.keys(cleanMcpServers).length > 0 ? { mcpServers: cleanMcpServers } : null,
      checklist: deduplicateChecklist(checklist),
      appliedPacks,
      warnings,
    };
  }

  function deduplicateChecklist(items) {
    const seen = new Set();
    const result = [];
    for (const item of items) {
      const key = item.trim().toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      result.push(item);
    }
    return result;
  }

  // ─── Run Snapshots ───

  function listRunSnapshots(runId) {
    return stmts.listRunSnapshots.all(runId);
  }

  /**
   * Record run skill pack snapshots (denormalized).
   */
  function recordRunSnapshots(runId, appliedPacks) {
    const insertSnapshot = db.prepare(`
      INSERT INTO run_skill_packs (run_id, skill_pack_id, skill_pack_name, prompt_text, prompt_hash,
        mcp_config_snapshot, checklist_snapshot, applied_mode, applied_order, effective_priority)
      VALUES (@run_id, @skill_pack_id, @skill_pack_name, @prompt_text, @prompt_hash,
        @mcp_config_snapshot, @checklist_snapshot, @applied_mode, @applied_order, @effective_priority)
    `);
    const insertAll = db.transaction(() => {
      for (const pack of appliedPacks) {
        insertSnapshot.run({
          run_id: runId,
          skill_pack_id: pack.id,
          skill_pack_name: pack.name,
          prompt_text: pack.promptText,
          prompt_hash: pack.promptHash,
          mcp_config_snapshot: pack.mcpConfigSnapshot,
          checklist_snapshot: pack.checklistSnapshot,
          applied_mode: pack.mode,
          applied_order: pack.order,
          effective_priority: pack.effectivePriority,
        });
      }
    });
    insertAll();
  }

  return {
    // CRUD
    createSkillPack,
    getSkillPack,
    listSkillPacks,
    updateSkillPack,
    deleteSkillPack,
    // MCP templates
    listMcpTemplates,
    getMcpTemplate,
    // MCP resolution
    resolveMcpServers,
    validateMcpEnvOverrides,
    // Project bindings
    listProjectBindings,
    bindToProject,
    updateProjectBinding,
    unbindFromProject,
    // Task bindings
    listTaskBindings,
    bindToTask,
    unbindFromTask,
    // Resolution
    resolveForRun,
    // Run snapshots
    listRunSnapshots,
    recordRunSnapshots,
    // Exported for testing
    _isEnvKeyDenied: isEnvKeyDenied,
    _estimateTokens: estimateTokens,
    _DEFAULT_MCP_TEMPLATES: DEFAULT_MCP_TEMPLATES,
  };
}

module.exports = { createSkillPackService };
