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

// RunInspector — 6 tabs + cost cards + diff/output empty states.
// Tab keys (output / events / diff / costs / skills / preset) match
// the local INSPECTOR_TABS const in RunInspector.js so the component
// can drive both id and label from one source.
export const RUN_INSPECTOR_LABELS = {
  title: '실행 인스펙터',
  unknownTitle: '실행 상세',
  closeAria: '실행 인스펙터 닫기',
  // tabs
  output: '실시간 출력',
  events: '이벤트',
  diff: 'Diff',
  costs: '비용',
  skills: '스킬',
  preset: '프리셋',
  // Live Output
  waitingOutput: '출력을 기다리는 중...',
  noOutput: '캡처된 출력이 없습니다.',
  // Events
  noEvents: '아직 이벤트가 없습니다.',
  // Diff
  loadingDiff: 'Diff 불러오는 중...',
  diffTruncated: '⚠ Diff가 1MiB에서 잘렸습니다 — 앞부분만 표시됩니다. 전체 변경은 워크트리에서 직접 확인하세요.',
  diffNoWorktree: '이 실행은 격리된 git 워크트리를 생성하지 않았습니다.',
  diffWorktreeMissing: '워크트리 디렉터리가 더 이상 존재하지 않습니다 (정리되었을 수 있습니다).',
  diffComputeFailed: 'Diff를 계산할 수 없습니다.',
  diffNoChanges: '워크트리에 커밋되지 않은 변경이 없습니다.',
  // Costs
  costEmpty: '이 어댑터는 비용 데이터를 제공하지 않습니다.',
  costEmptySub: 'Claude Code 워커와 Codex 매니저 세션은 사용량을 보고합니다. OpenCode 등 다른 어댑터는 미제공입니다.',
  workerCost: '워커 비용',
  workerCostSub: '워커 어댑터가 완료 시 보고한 값입니다.',
  inputTokens: '입력 토큰',
  outputTokens: '출력 토큰',
  cachedInput: '캐시된 입력',
  cost: '비용',
  managerUsage: '매니저 사용량',
  managerUsageTurnSuffix: '턴',
  tokensUnit: '토큰',
  managerUsageSub: '실행 이벤트의 mgr.usage를 합산합니다. Codex는 달러 비용을 보고하지 않습니다.',
  // Skills
  skillsLoading: '불러오는 중...',
  skillsEmpty: '이 실행에 적용된 스킬 팩이 없습니다.',
  showMcp: 'MCP 설정 보기',
  hideMcp: 'MCP 설정 숨기기',
  // Preset
  presetLoading: '프리셋 스냅샷 불러오는 중...',
  presetRefreshFailed: '프리셋 스냅샷을 새로 불러오지 못했습니다',
  presetNoBinding: '이 실행에 프리셋이 바인딩되지 않았습니다.',
  presetIdLabel: '프리셋 ID',
  presetSnapshotHash: '스냅샷 해시',
  presetApplied: '적용 시각',
  presetDeleted: '⚠ 이 실행 이후 프리셋이 삭제되었습니다. 아래 스냅샷이 유일한 기록입니다.',
  presetFileDriftError: '⚠ 프리셋 파일 드리프트를 계산할 수 없습니다. 핵심 필드 드리프트는 표시되지만 플러그인 파일 비교는 사용할 수 없습니다.',
  presetFileDriftReason: '사유',
  presetDrift: '⚠ 프리셋 드리프트가 감지되었습니다.',
  presetChangedFields: '변경된 필드',
  presetChangedFiles: '변경된 플러그인 파일',
  presetMatch: '✓ 프리셋이 스냅샷과 일치합니다 — 드리프트 없음.',
  mcpDriftIntro: 'MCP 템플릿이 실행 시작 이후 수정되었습니다.',
  mcpDriftDetail: '프리셋 스냅샷은 템플릿 본문이 아니라 ID만 동결합니다. 다음 alias가 실행 spawn 이후 변경되었습니다:',
  mcpDriftUpdated: '업데이트',
  snapshotRunTime: '스냅샷 (실행 시점)',
  currentPreset: '현재 프리셋',
  currentPresetDeleted: '(삭제됨)',
  // Status / summary
  summary: '요약',
  startedPrefix: '시작',
  cancelConfirm: '이 실행을 취소할까요?',
  // Send input row
  sendPlaceholder: '에이전트에게 입력 보내기...',
  sendingShort: '...',
  managerNotice: '✦ Top Manager가 다음 턴에 이 직접 메시지에 대해 알림을 받습니다.',
};

// DriftDrawer — header chrome + dismiss / restore actions.
export const DRIFT_LABELS = {
  title: '⚠ 드리프트',
  restorePrefix: '복원',
  restoreSuffix: '항목',
  closeAria: '드리프트 패널 닫기',
  empty: '모든 PM 주장과 DB 상태가 일치합니다.',
  emptySub: 'PM이 잘못된 주장을 기록하면 여기에 표시됩니다.',
  dismiss: '숨기기',
  dismissTitle: '이 클라이언트에서 숨김 (서버 기록은 보존됨)',
  pmClaimed: 'PM 주장',
  dbTruth: 'DB 실제',
  pmRunIdLabel: 'pm_run_id',
  rationaleLabel: '사유',
};

// TaskDetailPanel + NewTaskModal + ExecuteModal — task surfaces.
// Status / priority / project enums are still rendered via
// statusLabel(TASK_STATUS_LABELS, …) and FILTER_LABELS.priority* —
// those are NOT duplicated here.
export const TASK_DETAIL_LABELS = {
  detailTitle: '작업 상세',
  closeAria: '닫기',
  status: '상태',
  priority: '우선순위',
  project: '프로젝트',
  recurrence: '반복',
  dueDate: '마감일',
  created: '생성',
  noProject: '없음',
  recurrenceNone: '없음',
  recurrenceDaily: '매일',
  recurrenceWeekly: '매주',
  recurrenceMonthly: '매월',
  clearDueDate: '마감일 지우기',
  runsSection: '실행',
  resultsSection: '결과',
  agentFallback: '에이전트',
  viewRun: '실행 보기',
  runAgent: '에이전트 실행',
  delete: '삭제',
  deleteConfirm: '이 작업을 삭제할까요? 되돌릴 수 없습니다.',
  deleteSuccess: '작업이 삭제되었습니다',
  descPlaceholder: '설명 추가...',
  editTitleAria: '제목 편집',
  editDescAria: '설명 편집',
};

export const NEW_TASK_LABELS = {
  title: '새 작업',
  fieldTitle: '제목',
  titlePlaceholder: '작업 제목',
  fieldDescription: '설명',
  descriptionPlaceholder: '설명 (선택 사항)',
  fieldProject: '프로젝트',
  projectNone: '없음',
  fieldPriority: '우선순위',
  fieldAgent: '에이전트 프로필',
  agentNone: '없음',
  fieldDueDate: '마감일',
  fieldRecurrence: '반복',
  recurrenceTooltip: '마감일이 없으면 완료 시 다시 생성됩니다',
  recurrenceNone: '없음',
  recurrenceDaily: '매일',
  recurrenceWeekly: '매주',
  recurrenceMonthly: '매월',
  creating: '생성 중...',
  create: '작업 생성',
};

export const EXECUTE_MODAL_LABELS = {
  titlePrefix: '작업 실행',
  fieldAgent: '에이전트 프로필',
  agentSelect: '에이전트 선택...',
  fieldPrompt: '프롬프트 / 지시사항',
  promptPlaceholder: '에이전트에게 전달할 지시사항...',
  fieldPreset: '워커 프리셋',
  presetNone: '없음 (기본값 — 호스트 환경)',
  presetIsolatedSuffix: ' (격리)',
  presetTaskDefaultPrefix: '작업 기본값',
  presetTaskDefaultSuffix: '입니다.',
  skillPacksTitle: '스킬 팩',
  skillPacksNoPromptSupport: '이 에이전트는 {system_prompt_file}을 지원하지 않습니다. 스킬 팩 프롬프트는 건너뜁니다.',
  skillSourceAuto: '자동 적용',
  skillSourceTask: '작업 바인딩',
  skillExcludedSuffix: ' (제외)',
  tokensUnit: '토큰',
  budgetSeparator: '/',
  conflictAlias: 'MCP "{alias}" 충돌',
  conflictBlocking: ' — 실행 차단됨 (fail 정책)',
  conflictWarn: ' — 우선순위 높은 팩이 적용됨',
  starting: '시작 중...',
  startAgent: '에이전트 시작',
};

// DirectoryPicker — generic, used by ProjectsView and BoardView.
// Lifted out of view-specific groups because the picker is a small
// reusable widget; treating it as its own group keeps the field +
// modal copy reachable from any view that mounts the component.
export const DIRECTORY_PICKER_LABELS = {
  fieldLabel: '디렉터리',
  inputPlaceholder: '프로젝트 디렉터리 선택...',
  browse: '찾아보기',
  clear: '디렉터리 지우기',
  modalTitle: '디렉터리 선택',
  showHidden: '숨김 항목 표시',
  loading: '불러오는 중...',
  empty: '하위 폴더가 없습니다.',
  upHint: '상위 폴더',
  select: '선택',
};

// ProjectsView — list page header, ProjectDetailModal, New/Edit modals,
// and the ProjectSkillPacks subsection. Project status (`tasks.status`)
// continues to resolve through `TASK_STATUS_LABELS`; only project-page
// chrome lives here.
export const PROJECTS_LABELS = {
  pageTitle: '프로젝트',
  newProject: '새 프로젝트',
  emptyText: '아직 프로젝트가 없습니다.',
  emptySub: '작업을 정리하려면 프로젝트를 생성하세요.',
  taskCountSuffix: '개',
  taskWord: '개 작업',
  detailTitle: '프로젝트 상세',
  directoryLabel: '디렉터리',
  mcpConfigLabel: 'MCP 설정',
  tasksLabel: '작업',
  totalSuffix: '개',
  activeDoneLabel: '진행 / 완료',
  runsLabel: '실행',
  runsTotalSuffix: '회',
  runsRunningPrefix: '실행 중',
  createdLabel: '생성',
  tasksSection: '작업',
  noTasks: '이 프로젝트에 할당된 작업이 없습니다.',
  runSingular: '회 실행',
  // Modal — new / edit
  modalNew: '새 프로젝트',
  modalEdit: '프로젝트 편집',
  fieldName: '이름',
  namePlaceholder: '프로젝트 이름',
  fieldDescription: '설명',
  descriptionPlaceholder: '선택 사항',
  fieldMcpConfigPath: 'MCP 설정 경로',
  mcpConfigPathPlaceholder: '/path/to/mcp-config.json (선택 사항)',
  mcpConfigPathHint: 'Claude CLI --mcp-config 용 프로젝트 범위 MCP 서버 설정 파일',
  creating: '생성 중...',
  saving: '저장 중...',
  // Skill pack bindings (subsection)
  skillPacksTitle: '스킬 팩',
  skillPacksLoading: '스킬 팩 불러오는 중...',
  skillPackAddOption: '스킬 팩 추가...',
  skillPackAddBtn: '추가',
  skillPackAuto: '자동',
  skillPackManual: '수동',
  skillPackAutoToggleHint: 'auto_apply 활성화는 PM 리셋이 필요할 수 있습니다',
  skillPackPriorityTitle: '우선순위',
  skillPackPmActiveWarning: '⚠ PM이 활성 상태일 때 auto_apply 변경은 적용을 위해 PM 리셋이 필요할 수 있습니다.',
};

// AgentsView — list, AgentModal, AgentDetailModal. Agent type values
// (claude-code/codex/etc.) are kept as raw enums in <option> for
// preset-aware code paths; only chrome and form labels are localized.
export const AGENTS_LABELS = {
  pageTitle: '에이전트 프로필',
  newAgent: '새 에이전트',
  emptyText: '아직 에이전트 프로필이 없습니다.',
  emptySub: '작업 실행 방식을 구성하려면 에이전트 프로필을 생성하세요.',
  // Modal — new / edit
  modalNew: '새 에이전트',
  modalEdit: '에이전트 편집',
  fieldName: '이름',
  namePlaceholder: '에이전트 이름',
  fieldType: '종류',
  fieldCommand: '명령',
  commandPlaceholder: '예: claude',
  fieldArgsTemplate: '인자 템플릿',
  argsTemplatePlaceholder: '예: --model {{model}}',
  fieldIcon: '아이콘',
  iconPlaceholder: '이모지 또는 기호',
  fieldColor: '색상',
  fieldMaxConcurrent: '동시 실행 최대',
  fieldMcpTools: 'MCP 도구',
  mcpToolsHint: '한 줄당 하나의 패턴. 와일드카드 지원 (예: mcp__slack__*)',
  // Card actions — `update` / `delete` reuse COMMON_ACTIONS so the
  // verb stays in lockstep across surfaces. Only the confirm prefix
  // is agent-specific (it's "에이전트 삭제 …" not "삭제 …").
  deleteConfirmPrefix: '에이전트 삭제',
  deleteConfirmSuffix: '?',
  // Detail modal
  detailTitle: '에이전트 상세',
  configurationSection: '구성',
  fieldRunningNow: '현재 실행 중',
  cardCommandLabel: 'Command',
  cardMaxConcurrentLabel: 'Max Concurrent',
  usageSection: '사용량 및 한도',
  usageLoading: '사용량 데이터 불러오는 중...',
  usageRefresh: '새로고침',
  usageRefreshing: '불러오는 중...',
  usageOpenaiLoginRequired: 'OpenAI 로그인 필요',
  usageRemainingSuffix: '% 남음',
  usageResetsInPrefix: '재설정',
  usageUpdatedPrefix: '업데이트',
  usageAccountLabel: '계정',
  usagePlanLabel: '요금제',
  usageAuthTypeLabel: '인증 유형',
  // Time fragments — `formatResetTime`
  resetNow: '곧',
};

// ManagerChat — auxiliary copy for the agent picker / auth status
// banner (the empty-prompt branch and the diagnostic strip). The
// dropdown <option> status text stays ASCII English on purpose: screen
// readers cannot suppress glyphs inside <option> labels, so plain
// English is the most reliably announced shape.
export const MANAGER_CHAT_AUX = {
  pickerGroupAria: '매니저 에이전트 선택',
  agentLabel: '에이전트',
  agentsLoading: '에이전트 프로필 불러오는 중…',
  agentsLoadFailed: '에이전트 프로필을 불러오지 못했습니다',
  retry: '다시 시도',
  noManagerAgents: '등록된 Claude Code 또는 Codex 에이전트가 없습니다.',
  goToAgentsPage: '에이전트 페이지로 이동',
  toCreateOne: '에서 추가하세요.',
  refreshAuth: '인증 상태 새로고침',
  authStateOk: '인증됨',
  authStateOkSourceSeparator: ' · ',
  authStateUnknown: '인증 상태를 확인할 수 없습니다. 서버가 구버전일 수 있습니다 — 서버를 재시작하고 새로고침하세요.',
  authStateMissing: '이 프로필에 대한 자격 증명이 없습니다.',
  remediationFixPrefix: '자격 증명을 ',
  remediationFixLink: '에이전트 페이지',
  remediationFixSuffix: '에서 수정한 뒤, ',
  remediationRefreshLink: '새로고침',
  remediationFixEnd: '하세요.',
  remediationTryRefreshLink: '새로고침',
  remediationTryAfter: ' 해 보세요. 문제가 지속되면 서버를 재시작해 최신 코드를 반영하세요.',
};

// Drift drawer — `dispatch_audit_log.incoherence_kind` enum.
// Server-side values are kept in English (`pm_hallucination`,
// `user_intervention_stale`, `invalid_claim`) so the audit row JSON
// stays portable; the drawer renders the localized label.
export const INCOHERENCE_KIND_LABELS = {
  pm_hallucination: 'PM 환각',
  user_intervention_stale: '사용자 개입 미반영',
  invalid_claim: '잘못된 주장',
  unknown: '알 수 없음',
};

// Preset snapshot drift — `changed_files[].status` enum from the
// server's diff comparison. Renders inside the Preset tab inside the
// RunInspector.
export const PRESET_FILE_STATUS_LABELS = {
  added: '추가',
  deleted: '삭제',
  modified: '수정',
};

// Helper: lookup a status label, returning the raw status if the key
// isn't mapped. Components shouldn't need this guard for known status
// strings, but Manager/Top status comes from server-side state machines
// that occasionally surface transient values during migrations.
export function statusLabel(map, status) {
  if (!status) return '';
  return map[status] || status;
}
