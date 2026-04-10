/**
 * 경량 입력 검증 미들웨어 (P5-9)
 *
 * zod/ajv 없이 수동 검증 — 의존성 추가 최소화.
 * 잘못된 입력은 400 + 명확한 에러 메시지로 즉시 거절.
 * Express 5: throw 하면 자동으로 errorHandler 로 전달됨.
 *
 * 설계 원칙:
 * - 필수 필드 누락/빈 문자열 → 400
 * - 타입 불일치 (숫자 필드에 문자열 등) → 400
 * - 선택 필드는 제공된 경우에만 타입 검증, 없으면 통과
 * - 서비스 계층의 enum/format 검증과 중복하지 않음 (신뢰 계층 분리)
 */

const { BadRequestError } = require('../utils/errors');

// 필수 문자열 필드 검증: null/undefined/비어있는 문자열을 모두 거절
function requireString(body, field, label) {
  const val = body[field];
  if (val === undefined || val === null || val === '') {
    throw new BadRequestError(`${label || field} is required`);
  }
  if (typeof val !== 'string') {
    throw new BadRequestError(`${label || field} must be a string`);
  }
}

// 선택 문자열 필드 검증: 제공된 경우 string 타입 확인 (null은 허용 — 클리어 의미)
function optionalString(body, field, label) {
  if (!(field in body)) return;
  const val = body[field];
  if (val === null || val === undefined) return; // null = 클리어
  if (typeof val !== 'string') {
    throw new BadRequestError(`${label || field} must be a string`);
  }
}

// 선택 숫자 필드 검증: 제공된 경우 finite number 확인 (null은 허용)
function optionalNumber(body, field, label) {
  if (!(field in body)) return;
  const val = body[field];
  if (val === null || val === undefined) return;
  if (typeof val !== 'number' || !Number.isFinite(val)) {
    throw new BadRequestError(`${label || field} must be a number`);
  }
}

// 선택 boolean/0-1 필드: boolean, 0, 1 허용 (null 포함)
function optionalBoolish(body, field, label) {
  if (!(field in body)) return;
  const val = body[field];
  if (val === null || val === undefined) return;
  if (val !== true && val !== false && val !== 0 && val !== 1) {
    throw new BadRequestError(`${label || field} must be a boolean or 0/1`);
  }
}

// ─────────────────────────────────────────────────────────
// Tasks
// ─────────────────────────────────────────────────────────

/**
 * POST /api/tasks — task 생성 검증
 * 필수: title (string)
 * 선택: description, project_id, priority, status, due_date, recurrence,
 *       task_kind, acceptance_criteria, suggested_agent_profile_id (string or null)
 *       requires_capabilities (array or null)
 */
function validateCreateTask(req, res, next) {
  const body = req.body || {};
  requireString(body, 'title', 'Task title');
  optionalString(body, 'description', 'description');
  optionalString(body, 'project_id', 'project_id');
  optionalString(body, 'priority', 'priority');
  optionalString(body, 'status', 'status');
  optionalString(body, 'due_date', 'due_date');
  optionalString(body, 'recurrence', 'recurrence');
  optionalString(body, 'task_kind', 'task_kind');
  optionalString(body, 'acceptance_criteria', 'acceptance_criteria');
  optionalString(body, 'suggested_agent_profile_id', 'suggested_agent_profile_id');
  // requires_capabilities: array or null
  if ('requires_capabilities' in body) {
    const val = body.requires_capabilities;
    if (val !== null && val !== undefined && !Array.isArray(val)) {
      throw new BadRequestError('requires_capabilities must be an array or null');
    }
  }
  next();
}

/**
 * PATCH /api/tasks/:id — task 수정 검증
 * 모든 필드가 선택적이지만, 제공 시 타입을 검증함
 * title 만 제공되면 빈 문자열 금지
 */
function validateUpdateTask(req, res, next) {
  const body = req.body || {};
  // title 이 제공된 경우 빈 문자열 금지
  if ('title' in body) {
    const val = body.title;
    if (val === null || val === '') {
      throw new BadRequestError('Task title cannot be empty');
    }
    if (typeof val !== 'string') {
      throw new BadRequestError('title must be a string');
    }
  }
  optionalString(body, 'description', 'description');
  optionalString(body, 'project_id', 'project_id');
  optionalString(body, 'priority', 'priority');
  optionalString(body, 'due_date', 'due_date');
  optionalString(body, 'recurrence', 'recurrence');
  optionalString(body, 'task_kind', 'task_kind');
  optionalString(body, 'acceptance_criteria', 'acceptance_criteria');
  optionalString(body, 'suggested_agent_profile_id', 'suggested_agent_profile_id');
  if ('requires_capabilities' in body) {
    const val = body.requires_capabilities;
    if (val !== null && val !== undefined && !Array.isArray(val)) {
      throw new BadRequestError('requires_capabilities must be an array or null');
    }
  }
  next();
}

// ─────────────────────────────────────────────────────────
// Agents
// ─────────────────────────────────────────────────────────

/**
 * POST /api/agents — agent profile 생성 검증
 * 필수: name (string), type (string), command (string)
 * 선택: args_template, capabilities_json, env_allowlist, icon, color (string or null)
 *       max_concurrent (number or null)
 */
function validateCreateAgent(req, res, next) {
  const body = req.body || {};
  requireString(body, 'name', 'Agent name');
  requireString(body, 'type', 'Agent type');
  requireString(body, 'command', 'Agent command');
  optionalString(body, 'args_template', 'args_template');
  optionalString(body, 'capabilities_json', 'capabilities_json');
  optionalString(body, 'env_allowlist', 'env_allowlist');
  optionalString(body, 'icon', 'icon');
  optionalString(body, 'color', 'color');
  optionalNumber(body, 'max_concurrent', 'max_concurrent');
  next();
}

/**
 * PATCH /api/agents/:id — agent profile 수정 검증
 * 모든 필드가 선택적이지만, 제공 시 타입 검증
 */
function validateUpdateAgent(req, res, next) {
  const body = req.body || {};
  if ('name' in body) {
    const val = body.name;
    if (val === null || val === '') {
      throw new BadRequestError('Agent name cannot be empty');
    }
    if (typeof val !== 'string') {
      throw new BadRequestError('name must be a string');
    }
  }
  if ('type' in body) {
    const val = body.type;
    if (val === null || val === '') {
      throw new BadRequestError('Agent type cannot be empty');
    }
    if (typeof val !== 'string') {
      throw new BadRequestError('type must be a string');
    }
  }
  if ('command' in body) {
    const val = body.command;
    if (val === null || val === '') {
      throw new BadRequestError('Agent command cannot be empty');
    }
    if (typeof val !== 'string') {
      throw new BadRequestError('command must be a string');
    }
  }
  optionalString(body, 'args_template', 'args_template');
  optionalString(body, 'capabilities_json', 'capabilities_json');
  optionalString(body, 'env_allowlist', 'env_allowlist');
  optionalString(body, 'icon', 'icon');
  optionalString(body, 'color', 'color');
  optionalNumber(body, 'max_concurrent', 'max_concurrent');
  next();
}

// ─────────────────────────────────────────────────────────
// Projects
// ─────────────────────────────────────────────────────────

/**
 * POST /api/projects — project 생성 검증
 * 필수: name (string)
 * 선택: directory, description, color, mcp_config_path, preferred_pm_adapter (string or null)
 *       budget_usd (number or null), pm_enabled (boolean/0/1 or null)
 */
function validateCreateProject(req, res, next) {
  const body = req.body || {};
  requireString(body, 'name', 'Project name');
  optionalString(body, 'directory', 'directory');
  optionalString(body, 'description', 'description');
  optionalString(body, 'color', 'color');
  optionalString(body, 'mcp_config_path', 'mcp_config_path');
  optionalString(body, 'preferred_pm_adapter', 'preferred_pm_adapter');
  optionalNumber(body, 'budget_usd', 'budget_usd');
  optionalBoolish(body, 'pm_enabled', 'pm_enabled');
  next();
}

/**
 * PATCH /api/projects/:id — project 수정 검증
 * 모든 필드가 선택적이지만, 제공 시 타입 검증
 */
function validateUpdateProject(req, res, next) {
  const body = req.body || {};
  if ('name' in body) {
    const val = body.name;
    if (val === null || val === '') {
      throw new BadRequestError('Project name cannot be empty');
    }
    if (typeof val !== 'string') {
      throw new BadRequestError('name must be a string');
    }
  }
  optionalString(body, 'directory', 'directory');
  optionalString(body, 'description', 'description');
  optionalString(body, 'color', 'color');
  optionalString(body, 'mcp_config_path', 'mcp_config_path');
  optionalString(body, 'preferred_pm_adapter', 'preferred_pm_adapter');
  optionalNumber(body, 'budget_usd', 'budget_usd');
  optionalBoolish(body, 'pm_enabled', 'pm_enabled');
  next();
}

module.exports = {
  validateCreateTask,
  validateUpdateTask,
  validateCreateAgent,
  validateUpdateAgent,
  validateCreateProject,
  validateUpdateProject,
};
