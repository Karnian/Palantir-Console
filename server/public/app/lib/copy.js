// Semantic copy module for Korean UI labels.
//
// Phase K-1a (2026-04-27): centralizes user-facing strings so the same
// status / action / nav label resolves to one canonical Korean phrase
// across BoardView, SessionGrid, ManagerView, DashboardView, the
// command palette, etc. Earlier the same status was hand-typed in
// English at multiple call sites with subtle drift ("Done" vs
// "Completed", "In Progress" vs "running"). The semantic-key shape
// (TASK_STATUS_LABELS[task.status], not LOCALE['Done']) lets a future
// English revert flip a single map without touching components.
//
// Add new keys here, NOT inline in components. If the same phrase
// shows up in two places it should live in one of these maps.

// Task lifecycle (server/db `tasks.status`).
export const TASK_STATUS_LABELS = {
  backlog: '백로그',
  todo: '할 일',
  in_progress: '진행 중',
  review: '리뷰',
  done: '완료',
  failed: '실패',
};

// Run lifecycle (server/db `runs.status`). The set is wider than tasks
// because runs can be queued/stopped/cancelled before reaching done.
export const RUN_STATUS_LABELS = {
  queued: '대기 중',
  running: '실행 중',
  needs_input: '입력 필요',
  completed: '완료',
  failed: '실패',
  stopped: '중지됨',
  cancelled: '취소됨',
};

// Manager lifecycle (Top + PM).
export const MANAGER_STATUS_LABELS = {
  active: '활성',
  idle: '대기 중',
  starting: '시작 중',
  stopping: '중지 중',
};

// Top-level navigation. Keys match `NAV_ITEMS[].hash` in app/lib/nav.js
// so the nav module can stay a thin route table.
export const NAV_LABELS = {
  dashboard: '대시보드',
  manager: '매니저',
  board: '작업 보드',
  projects: '프로젝트',
  agents: '에이전트',
  skills: '스킬 팩',
  presets: '프리셋',
  'mcp-servers': 'MCP 서버',
};

// Reusable verb labels — covers ~80% of button copy across modals.
// Components import only what they need (no namespace pollution).
export const COMMON_ACTIONS = {
  cancel: '취소',
  save: '저장',
  update: '업데이트',
  create: '생성',
  close: '닫기',
  delete: '삭제',
  edit: '편집',
  refresh: '새로고침',
  send: '보내기',
  start: '시작',
  stop: '중지',
  reset: '리셋',
  open: '열기',
  loading: '불러오는 중...',
  saving: '저장 중...',
  starting: '시작 중...',
  sending: '보내는 중...',
};

// Filter / sort placeholder copy that recurs across BoardView toolbars
// and DashboardView quick filters.
export const FILTER_LABELS = {
  allProjects: '전체 프로젝트',
  allPriorities: '전체 우선순위',
  allDueDates: '전체 마감일',
  noDueDate: '마감일 없음',
  overdue: '지난 마감',
  dueToday: '오늘 마감',
  dueThisWeek: '이번 주 (7일 이내)',
  // Priority levels — `BoardView` priority filter, `TaskCard` badge.
  priorityLow: '낮음',
  priorityMedium: '보통',
  priorityHigh: '높음',
  priorityCritical: '긴급',
};

// Manager / Sessions chrome — surface that doesn't fit any other map.
// Kept narrow on purpose; if a phrase shows up only once and never
// repeats elsewhere, leave it inline.
export const MANAGER_LABELS = {
  startManager: '매니저 시작',
  stopTop: '매니저 중지',
  resetPM: 'PM 리셋',
  managerSession: '매니저 세션',
  taskSessions: '작업 세션',
  newTask: '새 작업',
  active: '활성',
  idle: '대기 중',
};

// Helper: lookup a status label, returning the raw status if the key
// isn't mapped. Components shouldn't need this guard for known status
// strings, but Manager/Top status comes from server-side state machines
// that occasionally surface transient values during migrations.
export function statusLabel(map, status) {
  if (!status) return '';
  return map[status] || status;
}
