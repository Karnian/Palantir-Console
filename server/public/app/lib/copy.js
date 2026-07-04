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

// Manager lifecycle (Top + Operator).
export const MANAGER_STATUS_LABELS = {
  active: '활성',
  idle: '대기 중',
  starting: '시작 중',
  stopping: '중지 중',
};

// Theme toggle (Phase K-2c) — three-state cycle button in NavSidebar.
// `system` is the default; selecting it removes any persisted choice
// and lets the OS prefers-color-scheme media query decide.
export const THEME_TOGGLE_LABELS = {
  ariaLabel: '테마 전환',
  modeSystem: '시스템 기본',
  modeLight: '라이트 모드',
  modeDark: '다크 모드',
  // Per-mode "...(으)로" suffix table — Korean particle depends on the
  // final consonant of the preceding word (받침). `tooltip(current,
  // next)` builds the full sentence; call sites only use that helper.
  tooltipPrefix: '테마',
  tooltipActionPrefix: '클릭하면',
  // Building blocks: tooltip(currentMode, nextMode) →
  //   `테마: 라이트 모드. 클릭하면 다크 모드로 전환`
  tooltip(current, next) {
    const label = (m) => m === 'system' ? this.modeSystem
      : m === 'light' ? this.modeLight : this.modeDark;
    // Korean particle "으로" attaches when the preceding noun ends in
    // a consonant other than ㄹ (시스템 기본 ends in ㄴ). "로"
    // attaches after vowels and ㄹ. Match per-mode so future mode
    // additions extend this table rather than rebuild the regex.
    const particle = (m) => m === 'system' ? '으로' : '로';
    return `${this.tooltipPrefix}: ${label(current)}. ${this.tooltipActionPrefix} ${label(next)}${particle(next)} 전환`;
  },
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
  nodes: '노드',
  memory: '메모리',
  specialist: '스페셜리스트',
  'operator-profiles': '오퍼레이터 프로필',
  // Tab group labels (nav consolidation)
  resources: '리소스',
  operator: '오퍼레이터',
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
  deleting: '삭제 중...',
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
//
// Phase Token-Cleanup (2026-04-27): the `active` / `idle` keys here
// duplicated `MANAGER_STATUS_LABELS.active|idle` and call sites
// inconsistently referenced one or the other. Removed in favor of the
// dedicated status map — call `MANAGER_STATUS_LABELS.active` or
// `statusLabel(MANAGER_STATUS_LABELS, key)` for any manager status
// rendering.
export const MANAGER_LABELS = {
  startManager: '매니저 시작',
  stopTop: '매니저 중지',
  resetPM: '오퍼레이터 리셋',
  managerSession: '매니저 세션',
  taskSessions: '작업 세션',
  newTask: '새 작업',
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
  // Harvest
  harvest: 'Harvest',
  harvestFiles: '파일',
  harvestCommits: '커밋',
  harvestBase: 'Base',
  harvestTruncated: '표시 항목이 제한되어 일부 파일, 커밋, stat이 생략되었습니다.',
  harvestTestPassed: '테스트 통과',
  harvestTestFailed: '테스트 실패',
  harvestTestTimeout: '테스트 시간초과',
  harvestOutput: '테스트 출력',
  harvestUnknownError: '알 수 없는 오류',
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
  testCommandLabel: '테스트 명령',
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
  fieldTestCommand: '테스트 명령',
  testCommandPlaceholder: '예: npm test',
  testCommandHint: '워커가 완료되면 harvest 단계에서 워크트리 안에서 실행합니다. 비워두면 건너뜁니다.',
  fieldNode: '노드',
  nodeDefaultOption: '기본 local 노드',
  nodeSelectLoading: '노드 불러오는 중...',
  allowNonGitDirLabel: '비-git 디렉터리 허용',
  allowNonGitDirHint: '비-git 디렉토리에서 워커 직접 실행 허용 (worktree 격리 없음)',
  nodeBadgePrefix: '노드',
  sharedDirectoryBadge: '공유 디렉터리',
  creating: '생성 중...',
  saving: '저장 중...',
  // Skill pack bindings (subsection)
  skillPacksTitle: '스킬 팩',
  skillPacksLoading: '스킬 팩 불러오는 중...',
  skillPackAddOption: '스킬 팩 추가...',
  skillPackAddBtn: '추가',
  skillPackAuto: '자동',
  skillPackManual: '수동',
  skillPackAutoToggleHint: 'auto_apply 활성화는 오퍼레이터 리셋이 필요할 수 있습니다',
  skillPackPriorityTitle: '우선순위',
  skillPackPmActiveWarning: '⚠ 오퍼레이터가 활성 상태일 때 auto_apply 변경은 적용을 위해 오퍼레이터 리셋이 필요할 수 있습니다.',
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

// CommandPalette (Cmd+K) — overlay chrome + filter input + empty state.
// Toast / loading copy from `app/lib/hooks/*.js` and `app/lib/toast.js`
// is grouped under TOAST_LABELS for the same reason the other surfaces
// have group lookups: a single source for "Failed to load X" patterns
// keeps wording consistent across loaders.
export const COMMAND_PALETTE_LABELS = {
  ariaLabel: '명령 팔레트',
  filterAriaLabel: '뷰 필터',
  empty: '일치하는 뷰가 없습니다',
  // Codex Post-K NIT (2026-04-28): the prefix/suffix chunk pair was a
  // workaround for a single dynamic value (NAV count). Inline copy
  // formatter functions are the cleaner i18n pattern — call sites do
  // `placeholder(NAV_ITEMS.length)` and the copy module owns word
  // order. If another surface needs a similar dynamic-value template
  // later, add a function here, not another `*Prefix`/`*Suffix` pair.
  placeholder(navCount) {
    return `이동... (1-${navCount} 키로 빠른 이동)`;
  },
};

// Hook-side toasts (loaders + manager start/stop). The
// `Failed to load X` template stays a parameterized prefix so call
// sites can append `: ${err.message || 'unknown'}` for diagnostics.
// `unknown` is intentionally English — it appears verbatim in
// developer console / server logs and changing it would mask the
// original raw error text.
export const TOAST_LABELS = {
  loadFailedTasks: '작업을 불러오지 못했습니다',
  loadFailedRuns: '실행을 불러오지 못했습니다',
  loadFailedProjects: '프로젝트를 불러오지 못했습니다',
  loadFailedAgents: '에이전트를 불러오지 못했습니다',
  // Synthetic fallback used only when `err.message` is empty/undefined.
  // Raw server messages still pass through unchanged (`${prefix}: ${err.message}`),
  // so this only surfaces when the error itself has no message at all.
  errorFallback: '알 수 없는 오류',
  managerStarted: '매니저 세션을 시작했습니다',
  managerStopped: '매니저 세션을 중지했습니다',
  managerStartFailed: '매니저를 시작하지 못했습니다',
  managerStopFailed: '매니저를 중지하지 못했습니다',
};

// DashboardView (Attention Dashboard) — page chrome + stats bar + drift
// chip + triage feed + active Claude sessions strip. Triage row meta
// strings read as `'${prefix} · ${timeAgo}'` (e.g. `'실행 중 · 5분 전'`);
// the prefix is the action verb here and `timeAgo` (now Korean per
// K-low-3) supplies the relative time fragment.
export const DASHBOARD_LABELS = {
  pageTitle: '주의 대시보드',
  statActive: '활성',
  statNeedsInput: '입력 필요',
  statFailed: '실패',
  statDoneToday: '오늘 완료',
  statDriftLabelPrefix: '드리프트',
  // Drift chip a11y / tooltip
  driftClickHint: 'PM 환각 / 정합성 인시던트. 클릭해서 살펴보세요.',
  driftAriaPrefix: '드리프트 경고',
  driftAriaSuffix: '건. 활성화하면 드리프트 패널이 열립니다.',
  // Triage feed empty state
  emptyText: '주의가 필요한 항목이 없습니다.',
  emptySub: '입력이 필요한 작업과 실행이 여기 표시됩니다.',
  // Triage row titles + meta prefix
  triageManagerTitle: '매니저 세션',
  triageManagerMetaActive: '활성',
  triageNeedsInputMeta: '입력 대기 중',
  triageFailedMeta: '실패',
  triageRunningMeta: '실행 중',
  triageReviewMeta: '리뷰 대기',
  // Run fallback title — shown when no task is bound. The run id is
  // appended after, so the result reads as `'실행 abc12345'`.
  runFallbackPrefix: '실행',
  // Triage action buttons
  actionRespond: '응답',
  actionDismiss: '숨기기',
  actionInspect: '점검',
  actionReview: '리뷰',
  actionOpen: '열기',
  // Active Claude Sessions strip
  claudeSessionsTitle: '활성 Claude 세션',
};

// PresetsView — list page header, PresetModal (create/edit), DeleteConfirm.
// Worker preset 핵심 surface; 가급적 COMMON_ACTIONS 재사용 + preset 전용
// 라벨만 그룹에 둠.
export const PRESETS_LABELS = {
  pageTitle: '워커 프리셋',
  newPreset: '새 프리셋',
  // Modal — new / edit
  modalNew: '새 워커 프리셋',
  modalEdit: '프리셋 편집',
  fieldName: '이름',
  namePlaceholder: '예: agent-olympus-isolated',
  fieldDescription: '설명',
  fieldIsolated: '격리 모드 (Tier 2 — Claude 전용)',
  isolatedHint: 'Claude 워커에만 적용됩니다. Codex / OpenCode 는 ',
  isolatedHintAfterCode: ' 경고를 받고 Tier 1 로 폴백합니다.',
  fieldBasePromptPrefix: '기본 시스템 프롬프트',
  fieldBasePromptByteSuffix: '바이트',
  basePromptPlaceholder: '선택 사항 — 스킬 팩 섹션 앞에 prepend 됩니다.',
  fieldPluginRefsLabel: '플러그인 참조',
  pluginRefsEmptySuffix: ' 안에 plugin.json 을 가진 디렉터리가 없습니다.',
  fieldMcpServers: 'MCP 서버 템플릿',
  mcpServersEmpty: '등록된 MCP 템플릿이 없습니다.',
  fieldMinVersion: '최소 Claude 버전 (Min Claude Version, 선택, semver)',
  minVersionPlaceholder: '예: 2.0.0',
  fieldSettingSources: '설정 소스 (Setting Sources, Tier 2 플래그, 기본 빈 값)',
  settingSourcesPlaceholder: "(빈 값 = --setting-sources '')",
  saveExceeds16kb: 'base_system_prompt 가 16KB 를 초과합니다',
  toastUpdated: '프리셋이 업데이트되었습니다',
  toastCreated: '프리셋이 생성되었습니다',
  // Plugin warnings strip
  pluginWarningsCountSuffix: '개 플러그인 디렉터리의 plugin.json 이 잘못되어 건너뜁니다:',
  // Empty state
  emptyText: '아직 프리셋이 없습니다',
  emptySub: '워커 프리셋은 플러그인 디렉터리, MCP 서버, 시스템 프롬프트를 묶어 워커 실행 간에 재사용합니다. 시작하려면 하나 만드세요.',
  // Card
  badgeIsolated: '격리 (Tier 2)',
  cardCountPlugin: '개 플러그인',
  cardCountMcp: '개 MCP 서버',
  cardMinVersionPrefix: '최소 Claude',
  // Delete confirm
  deleteTitle: '프리셋 삭제',
  deleteBodySuffix: ' 을(를) 삭제할까요? 이 프리셋에 연결된 작업의 링크는 해제되며, 과거 실행 스냅샷은 보존됩니다.',
  toastDeleted: '프리셋이 삭제되었습니다',
};

// MCP Templates — McpTemplatesView, TemplateModal, DeleteConfirm.
export const MCP_TEMPLATES_LABELS = {
  pageTitle: 'MCP 서버',
  newTemplate: '새 MCP 서버',
  // Modal
  modalNew: '새 MCP 템플릿',
  modalEdit: 'MCP 템플릿 편집',
  fieldAlias: 'Alias',
  aliasHint: '영문 / 숫자 / _ / -',
  aliasPlaceholder: 'graphify',
  aliasImmutableHint: 'Alias 는 변경할 수 없습니다 — 스킬 팩이 이 이름으로 템플릿을 참조합니다.',
  // M4-a: transport selector
  fieldTransport: 'Transport',
  transportStdio: 'stdio (로컬 프로세스)',
  transportHttp: 'http (원격 Streamable HTTP)',
  transportImmutableHint: 'Transport 는 변경할 수 없습니다 — 다른 transport 가 필요하면 새 alias 를 만드세요.',
  fieldUrl: 'URL',
  urlHint: 'http:// 또는 https:// — 사설 IP / metadata / 로컬 (옵트아웃 가능) 은 차단됩니다',
  urlPlaceholder: 'http://localhost:3100/mcp?profile=default',
  fieldBearerEnvVar: 'Bearer 토큰 env 변수 이름 (선택)',
  bearerEnvVarHint: '값이 아닌 *이름* 을 입력하세요. 워커는 spawn 시 process.env 에서 값을 읽습니다.',
  bearerEnvVarPlaceholder: 'BIFROST_MCP_TOKEN',
  bearerEnvVarWarn: '프로세스 로더 / 경로 가로채기 패턴 (NODE_OPTIONS, PATH 등) 은 전역적으로 차단됩니다.',
  validateHttpUrl: 'http transport 는 url 이 필수입니다',
  fieldCommand: '명령',
  commandPlaceholder: 'npx',
  fieldArgs: 'Args',
  argsHint: '문자열 JSON 배열',
  fieldEnv: '허용된 env 키',
  envHint: '쉼표 구분',
  envPlaceholder: 'GRAPHIFY_ROOT, LOG_LEVEL',
  envWarn: '인증 / 프로세스 로더 패턴 (*_KEY, NODE_OPTIONS, PATH 등) 은 전역적으로 차단됩니다.',
  fieldDescription: '설명',
  descriptionPlaceholder: '이 MCP 서버는 무엇을 하나요?',
  validateAliasCommand: 'alias 와 command 는 필수입니다',
  toastCreated: '템플릿이 생성되었습니다',
  toastUpdated: '템플릿이 업데이트되었습니다',
  // M4-a: card view
  cardBearerPrefix: 'bearer:',
  // Empty state
  emptyText: 'MCP 템플릿이 없습니다',
  emptySub: '프리셋과 스킬 팩이 alias 로 참조할 수 있도록 MCP 서버를 등록하세요.',
  // Card
  cardUpdatedPrefix: '업데이트',
  // Delete confirm
  deleteTitle: 'MCP 템플릿 삭제',
  deleteBodySuffix: ' 을(를) 삭제할까요?',
  // Args validation toast — used inside parseJsonArrayField fallback.
  invalidJsonArraySuffix: ' 은(는) 문자열의 JSON 배열이어야 합니다',
  inUseTitle: '사용 중',
  inUsePresetsLabel: '프리셋',
  inUseSkillPacksLabel: '스킬 팩',
  inUseRemediation: '삭제하기 전에 이 참조를 제거하세요.',
  noReferences: '참조가 없습니다 — 안전하게 삭제할 수 있습니다.',
  checkingReferences: '참조 확인 중…',
  toastDeleted: '템플릿이 삭제되었습니다',
};

// NodesView — Fleet node registry CRUD.
export const NODES_LABELS = {
  pageTitle: '노드',
  newNode: '새 노드',
  emptyText: '등록된 노드가 없습니다',
  emptySub: '로컬 또는 SSH 실행 노드를 등록하세요.',
  modalNew: '새 노드',
  modalEdit: '노드 편집',
  fieldName: '이름',
  namePlaceholder: '워크스테이션',
  fieldId: 'ID',
  idOptionalHint: '비워두면 서버가 생성합니다',
  idPlaceholder: 'node_seoul_01',
  idImmutableHint: 'ID는 변경할 수 없습니다.',
  fieldKind: 'Kind',
  kindLocal: 'local',
  kindSsh: 'ssh',
  kindImmutableHint: 'kind는 변경 불가, 새 노드를 만드세요',
  fieldSshHost: 'SSH 호스트',
  sshHostPlaceholder: 'worker.example.com',
  fieldSshUser: 'SSH 사용자',
  sshUserPlaceholder: 'ubuntu',
  fieldExposedRoots: 'exposed_roots',
  exposedRootsHint: '절대경로 문자열 JSON 배열',
  exposedRootsPlaceholder: '["/srv/workspaces"]',
  fieldNodePrefix: 'node_prefix',
  nodePrefixPlaceholder: '선택 사항',
  fieldMaxConcurrent: 'max_concurrent',
  maxConcurrentHint: '빈값 = 무제한',
  maxConcurrentPlaceholder: '무제한',
  fieldCapabilities: 'Capability',
  capabilities: {
    can_execute: 'can_execute',
    can_control: 'can_control',
    files_only: 'files_only',
    none: 'capability 없음',
  },
  capabilityHint: 'files_only와 can_execute는 동시에 켤 수 없습니다.',
  validateNameRequired: 'name은 필수입니다',
  validateSshRequired: 'ssh_host와 ssh_user는 SSH 노드에서 필수입니다',
  validateExposedRootsRequired: 'exposed_roots는 SSH 노드에서 필수입니다',
  validateMaxConcurrent: 'max_concurrent는 빈값 또는 1 이상의 정수여야 합니다',
  invalidJsonArraySuffix: ' 은(는) 문자열의 JSON 배열이어야 합니다',
  toastCreated: '노드가 생성되었습니다',
  toastUpdated: '노드가 업데이트되었습니다',
  toastDeleted: '노드가 삭제되었습니다',
  deleteTitle: '노드 삭제',
  deleteBodySuffix: ' 노드를 삭제할까요?',
  deleteHint: '프로젝트에 바인딩된 노드는 서버가 삭제를 거부합니다.',
  deleting: '삭제 중...',
  defaultNodeBadge: '기본 노드',
  defaultNodeDeleteHint: '기본 local 노드는 삭제할 수 없습니다',
  reachable: '연결됨',
  unreachable: '연결 끊김',
  sshTargetLabel: 'SSH',
  rootsCountSuffix: '개 루트',
  nodePrefixLabel: 'node_prefix',
  maxConcurrentLabel: 'max_concurrent',
  lastHeartbeatLabel: 'last_heartbeat_at',
  unlimited: '무제한',
  emptyValue: '—',
  detailBack: '← 노드 목록',
  detailAction: '상세 보기',
  usageAction: '사용량 보기',
  // Fleet list card relative heartbeat — mirrors lib/format.js `timeAgo`
  // wording. Kept as separate copy keys (not the shared helper) because the
  // jsdom test harness only pre-seeds specific format.js exports into its
  // sandbox; NodesView computes this locally (see relativeHeartbeat()).
  heartbeatNeverLabel: '하트비트 없음',
  heartbeatSkewLabel: '시간 불일치',
  heartbeatJustNow: '방금',
  heartbeatMinutesAgoSuffix: '분 전',
  heartbeatHoursAgoSuffix: '시간 전',
  heartbeatDaysAgoSuffix: '일 전',
  detailNotFound: '노드를 찾을 수 없습니다',
  detailUsageTitle: 'CLI 사용량',
  detailRefresh: '새로고침',
  detailRefreshing: '조회 중…',
  detailLoading: '노드 사용량을 조회하는 중입니다',
  detailRetry: '다시 시도',
  usageInstalled: '설치됨',
  usageNotInstalled: '미설치',
  usageVersionLabel: '버전',
  usageAccountLabel: '계정',
  usagePlanLabel: '플랜',
  usageAuthLabel: '인증',
  usageLoggedIn: '로그인됨',
  usageLoggedOut: '미로그인',
  usageOrgLabel: '조직',
  usageNoClis: '표시할 CLI 정보가 없습니다',
  usageNoLimits: '한도 데이터가 없습니다',
  usageRemainingSuffix: '% 남음',
  usageResetAtPrefix: '재설정',
  usageUpdatedPrefix: '업데이트',
  usageErrorLabels: {
    not_installed: '미설치',
    probe_failed: '조회 실패',
    timeout: '시간 초과',
    transport_lost: '노드 연결 끊김',
    no_data: '데이터 없음',
    not_logged_in: '미로그인',
    quota_unsupported: '쿼터 조회 미지원(v2)',
  },
};

// SkillPacksView, MyPacksView, SkillPackModal, DeleteConfirm.
export const SKILL_PACKS_LABELS = {
  pageTitle: '스킬 팩',
  // Page tabs
  tabMyPacks: '내 스킬 팩',
  tabGallery: '갤러리',
  // Top actions
  actionImport: '가져오기',
  actionNew: '새 스킬 팩',
  // Filter dropdowns
  filterAllScopes: '모든 범위',
  filterScopeGlobal: '전역',
  filterScopeProject: '프로젝트',
  filterAllProjects: '전체 프로젝트',
  filterScopeAria: '범위 필터',
  filterProjectAria: '프로젝트 필터',
  packsCountSuffix: '개',
  // Token budget
  tokenBudget: '토큰 예산',
  // Empty state
  emptyText: '스킬 팩이 없습니다',
  emptySub: '에이전트에 능력을 주입할 첫 스킬 팩을 만드세요.',
  // Card
  originBundled: '번들 제공',
  originUrlPrefix: 'URL',
  originImported: '가져옴',
  originManual: '직접 작성',
  cardCheckUpdate: '업데이트 확인',
  cardChecking: '확인 중...',
  cardExport: '내보내기',
  cardTokensSuffix: '토큰',
  // Scope label mapping for the card chip (`pack.scope`). Card class
  // ("global"/"project") still uses the raw enum so styling is stable;
  // only the visible chip text resolves through this map.
  scopeLabel: {
    global: '전역',
    project: '프로젝트',
  },
  toastInvalidJson: '유효하지 않은 JSON',
  toastUpToDate: '은(는) 최신 상태입니다',
  toastUpdateFailed: '업데이트 확인 실패',
  toastUpdateApplied: '업데이트되었습니다',
  // Update confirm — joined with `\n` at call site so copy.js stays
  // free of formatting concerns. Each line is a single semantic chunk.
  updateConfirmTitlePrefix: '업데이트 가능: ',
  updateConfirmHashLabel: '해시',
  updateConfirmFetchedLabel: '가져온 시각',
  updateConfirmQuestion: '업데이트를 적용할까요?',
  // Delete
  deleteTitle: '스킬 팩 삭제',
  deleteBodySuffix: ' 을(를) 삭제할까요? 모든 프로젝트와 작업 바인딩이 함께 제거됩니다.',
  // SkillPackModal — fields and tabs
  modalNew: '새 스킬 팩',
  modalEdit: '스킬 팩 편집',
  fieldName: '이름',
  namePlaceholder: '예: 접근성 전문가',
  fieldPriority: '우선순위',
  fieldDescription: '설명',
  descriptionPlaceholder: '간단한 설명...',
  fieldScope: '범위',
  scopeGlobal: '전역',
  scopeProject: '프로젝트',
  fieldProject: '프로젝트',
  selectProject: '프로젝트 선택...',
  fieldIcon: '아이콘',
  fieldColor: '색상',
  // tabs
  tabPrompt: '프롬프트',
  tabMcp: 'MCP 서버',
  tabChecklist: '체크리스트',
  tabPromptTokenSuffix: '토큰',
  fieldFullPrompt: '전체 프롬프트',
  fullPromptPlaceholder: '에이전트에 전달할 전체 스킬 지시사항...',
  fieldCompactPrompt: '압축 프롬프트 (선택)',
  compactPromptPlaceholder: '다중 스킬 토큰 예산을 위한 짧은 버전...',
  // mcp tab
  mcpAdd: 'MCP 서버 추가',
  mcpSelectTemplate: '템플릿 선택...',
  mcpEmpty: '구성된 MCP 서버가 없습니다',
  mcpUnknownTemplate: '알 수 없는 템플릿',
  mcpEnvDefault: '(기본값)',
  mcpConflictPolicy: '충돌 정책',
  mcpConflictWarn: '경고 (우선순위 높은 팩이 적용됨)',
  mcpConflictFail: '실패 (실행 차단)',
  // checklist tab
  checklistAddPlaceholder: '체크리스트 항목 추가...',
  checklistAddBtn: '추가',
  checklistInjectLabel: '에이전트 프롬프트에 체크리스트 주입',
  // adapter compat
  adapterSupport: '어댑터 지원',
  adapterClaudeFull: 'Claude ✔ Full',
  adapterCodexPrompt: 'Codex ✔ Prompt',
  adapterGeminiPrompt: 'Gemini ✔ Prompt',
};

// Skill Pack Gallery — install / browse / search.
export const GALLERY_LABELS = {
  searchPlaceholder: '스킬 팩 검색...',
  installFromUrl: 'URL 에서 설치',
  filterAll: '전체',
  allInstalled: '모든 팩이 설치됨',
  emptyText: '검색 결과가 없습니다',
  loadFailed: '레지스트리를 불러오지 못했습니다',
  loadingRegistry: '레지스트리 불러오는 중...',
  badgeInstalled: '설치됨',
  badgeUpdate: '업데이트 가능',
  installBtn: '설치',
  installing: '설치 중...',
  updateBtn: '업데이트',
  updating: '업데이트 중...',
  retry: '다시 시도',
  toastInstalled: '설치됨',
  toastUpdated: '업데이트됨',
  toastConflict: '이미 설치되었거나 이름 충돌',
  tokensSuffix: '토큰',
  // Registry category id → 한국어 display label. Categories ship from
  // the server registry (`server/data/skill-pack-registry.json`) with
  // English names ("Code Quality" / "Testing" / …). The id is stable
  // across releases and is what the cat filter button + card chip key
  // off, so we map id → label client-side. Unknown ids fall through
  // to the registry's own `cat.name`.
  categoryLabel: {
    'code-quality': '코드 품질',
    'testing': '테스트',
    'security': '보안',
    'devops': '데브옵스',
    'documentation': '문서화',
    'frontend': '프론트엔드',
    'backend': '백엔드',
    'general': '일반',
  },
};

// PackPreviewModal — registry pack preview before install/update.
export const PACK_PREVIEW_LABELS = {
  unknownAuthor: '알 수 없음',
  metaCategory: '카테고리',
  metaVersion: '버전',
  metaTokensFull: '토큰 (전체)',
  metaTokensCompact: '토큰 (압축)',
  metaPriority: '우선순위',
  updateNoticePrefix: '업데이트 가능: ',
  sourceSection: '출처 (URL 설치)',
  sourceUrlLabel: 'URL',
  sourceFetchedLabel: '가져온 시각',
  sourceHashLabel: '해시',
  promptSection: '프롬프트 (전체)',
  mcpSection: 'MCP 서버',
  mcpEnvPrefix: 'env',
  checklistSection: '체크리스트',
  capabilitiesSection: '필요 기능 (참고용)',
  installedLabelPrefix: '설치됨',
};

// UrlInstallDialog — install-from-URL flow (gallery v1.1).
export const URL_INSTALL_LABELS = {
  modalTitle: 'URL 에서 설치',
  helpText: 'https:// 로 시작하는 스킬 팩 JSON 파일 URL 을 붙여넣으세요 (예: GitHub raw, gist). 서버가 가져오기 / 검증 / 미리보기 후 설치합니다.',
  fieldUrlLabel: '스킬 팩 URL',
  urlPlaceholder: 'https://raw.githubusercontent.com/...',
  securityNotePrefix: '보안',
  securityNote: 'HTTPS 만 허용됩니다. 사설 IP, 루프백, 메타데이터 엔드포인트는 차단됩니다. 응답 크기는 256KB 로 제한됩니다.',
  fetchPreviewBtn: '가져오기 및 미리보기',
  fetching: '가져오는 중...',
  invalidHttpsToast: 'URL 은 https:// 로 시작해야 합니다',
  fetchFailedToast: 'URL 을 가져오지 못했습니다',
  installedFromUrlToastSuffix: ' (URL 에서 설치됨)',
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

// OperatorProfilesView — list, ProfileModal, DeleteConfirm.
export const OPERATOR_PROFILES_LABELS = {
  pageTitle: '오퍼레이터 프로필',
  pageDescription: '스페셜리스트가 사용할 프로필(페르소나 + 권한)을 관리합니다.',
  newProfile: '새 프로필',
  // Modal — new / edit
  modalNew: '새 오퍼레이터 프로필',
  modalEdit: '프로필 편집',
  fieldName: '이름',
  namePlaceholder: '예: 메타데이터 분석 전문가',
  fieldDescription: '설명',
  descriptionPlaceholder: '선택 사항',
  fieldPersona: '페르소나',
  personaPlaceholder: '이 오퍼레이터의 역할과 행동 방식을 설명하세요...',
  fieldCapabilities: '권한 (Capabilities)',
  toastCreated: '프로필이 생성되었습니다',
  toastUpdated: '프로필이 업데이트되었습니다',
  toastDeleted: '프로필이 삭제되었습니다',
  // Empty state
  emptyText: '프로필이 없습니다',
  emptySub: '새 프로필을 만들어 스페셜리스트에 사용하세요.',
  // Delete confirm
  deleteTitle: '프로필 삭제',
  deleteBodySuffix: ' 을(를) 삭제할까요? 이 프로필을 참조하는 향후 스페셜리스트 호출은 실패합니다(404). 진행 중인 호출은 영향받지 않습니다.',
};
