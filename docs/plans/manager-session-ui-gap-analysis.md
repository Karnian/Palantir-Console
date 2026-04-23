# Manager Session UI — Gap Analysis

> Analyzed: 2026-04-23
> Spec: `docs/specs/manager-session-ui.md` (v0.1, 1001 lines, Design Proposal)
> Analyst: readonly diff against HEAD `b2d6f98` (post-M3 main)
> Purpose: Back the adoption decision for the Scale-L proposal with a concrete "what's done / what isn't / what can ship first" breakdown.

## 1. Executive Summary

**Proposal lifecycle**: the UI spec was written (2026-04-05) before v3's multi-layer manager landed (Phase 0–10G). A lot of what the spec prescribes as *new* has in fact shipped incrementally under different names. The Scale-L estimate (2–3 weeks) therefore overstates the remaining work; the honest residual is closer to **0.7–1.0 week** split into three shippable phases — call it **R2-A / R2-B / R2-C**.

**Three big architectural deltas that already shipped** (and the spec does not yet reflect):

1. **Multi-layer conversation model** (`top` + `pm:<projectId>`) — the spec describes one Manager with per-session side panels. Current reality is Top manager + project-scoped PMs with lazy spawn, parent-notice queue, and dispatch audit. Any residual spec work must fit *inside* this model, not reintroduce a single-manager flattening.
2. **Attention surface is adjacent, not equivalent** — `triage-feed` at `server/public/app/components/DashboardView.js:196` is a *superset* of the spec's `AttentionStrip`: it includes `needs-input` and `failed` (spec-matching) but also `manager / running / review / overdue / due-soon`, and it renders an "All clear" empty state instead of hiding when empty. The extraction work needs to carve out an attention-only projection that matches spec §12.1 rather than lifting `triage-feed` verbatim.
3. **Drift observability layer** — `DriftDrawer`, `reconciliationService`, `mcp_template_drift` (M3) — sits beside the spec's notion of attention. The spec predates these and treats "manager lying / template moved" as out-of-scope; in practice both are already surfaced and must be cross-linked from any new Attention UI.

**Bottom line**: the spec's core thesis (chat-first orchestration with attention routing) is already 60–70% implemented. The remaining work is predominantly **UI reshaping + a few new endpoints** rather than a greenfield rewrite.

## 2. Coverage Matrix

Legend:
- **✅ Done**: requirement satisfied in current code, no follow-up needed for spec intent.
- **◐ Partial**: present but diverges from spec in a non-trivial way; a small phase would close the gap.
- **✗ Missing**: not implemented anywhere.
- **⊘ Out**: spec requires this but we should drop it (explain why).

### 2.1 Information Architecture (§7)

| Spec requirement | Status | Evidence |
|---|---|---|
| Ambient: total/active agent count | ✅ | `SessionGrid` header (`manager-grid-stats`: running/waiting/failed counts), SSE conn dot in NavSidebar |
| Ambient: Attention Badge (needs_input + failed) | ✗ | NavSidebar has no badge — only SSE status dot |
| Ambient: SSE connection status | ✅ | `NavSidebar` status-dot |
| Triage level: needs_input list | ◐ | `DashboardView.triage-feed` mixes it with running/review/overdue and renders an empty state; needs an attention-only projection filter |
| Triage level: failed list | ◐ | Same — Dashboard only, not attention-scoped |
| Triage level: blocked/stalled | ✗ | No "stalled" detection (runs that ran too long without event) |
| Triage level: review-pending tasks | ◐ | Dashboard covers "task status=review"; ManagerView does not |
| Overview level: active session grid | ✅ | `SessionGrid` renders all worker runs grouped |
| Overview level: completed section | ◐ | Done tasks live in `Done` status bucket (collapsed by default) — no per-run "completed today" section |
| Overview level: cost aggregate | ◐ | Only top manager cost in `ManagerChat` header, no aggregate across workers |
| Detail level: real-time output | ✅ | `RunInspector` tabs |
| Detail level: file diff | ✗ | No diff view in RunInspector |
| Detail level: event timeline | ✅ | `RunInspector` → events tab |
| Detail level: cost breakdown | ✗ | No per-run cost tab |

### 2.2 Status Visualization (§7.2, §14)

| Status | Color | Icon | Animation (spec) | Current |
|---|---|---|---|---|
| `needs_input` | amber | ⏸ | Pulse (breathing) | ◐ — color+icon present in `SessionGrid.runStatusColor/Icon` + priority alert on SSE; no pulse anim on SessionCard itself |
| `failed` | red | ✕ | None (static) | ✅ |
| `running` | blue | ● | Spin | ◐ — dot exists (`pm-spinner` selector), not applied to every SessionCard |
| `queued` | gray | ◌ | None | ◐ — color ok, icon is `○` not `◌` (trivial) |
| `completed` | green | ✓ | None | ✅ |
| `cancelled` | dim gray | — | None | ✅ |
| Attention Badge in sidebar | — | — | Badge pulse | ✗ |

Status for Dashboard triage-feed uses the same color/icon system — the codebase is consistent; it just isn't applied to ManagerView's SessionGrid cards yet.

### 2.3 Layout (§8)

| Spec requirement | Status | Notes |
|---|---|---|
| Desktop split: Chat 40% / Session Overview 60% | ◐ | `manager-view` has two-column layout; ratio tuning and resize handle unconfirmed in CSS |
| Drag-to-resize Chat/Overview split | ✗ | No resize handle |
| Slide-over Session Detail from right | ✗ | Detail opens as modal (`RunInspector`), not slide-over |
| Mobile single-column readonly (<768px) | ✗ | Media queries exist (640/960px breakpoints) but no ManagerView-specific mobile layout |
| Nav: Manager is default landing | ✗ | Dashboard is default (app.js route fallback) |

### 2.4 Component Hierarchy (§9)

| Spec component | Status | Current name / location |
|---|---|---|
| `NavSidebar.AttentionBadge` | ✗ | — |
| `ManagerView` | ✅ | `components/ManagerView.js` (thin shell) |
| `ManagerChatPanel` | ✅ | `components/ManagerChat.js` |
| `ChatHistory.UserMessage / ManagerMessage` | ✅ | message rendering in ManagerChat (markdown+code) |
| `ChatHistory.ActionPlanCard` | ✗ | No structured plan card |
| `SuggestedActions` | ✗ | No context-aware action buttons above input |
| `ChatInput` | ✅ | `MentionInput` + attach/paste images |
| `SessionOverviewPanel.AttentionStrip` | ◐ | Exists on Dashboard as `triage-feed`, missing on Manager view |
| `SessionOverviewPanel.SessionGrid` | ✗ | Grouping is `Project → status section → task summary` (`SessionGrid.js:51+`). Individual runs are NOT rendered as cards — only task-level aggregate counts ("3 running, 1 failed"). Spec §12.2's flat grid of run cards is absent. |
| `SessionCard` | ✗ | No per-run card anywhere. Run-level detail is only reachable via task → RunInspector modal. |
| `SessionOverviewPanel.CompletedSection` | ◐ | Completed tasks roll up under "Done" bucket (collapsible), not a per-run "Completed today" section |
| `SessionDetailPanel` as slide-over | ✗ | `RunInspector` is a modal |
| `SessionDetailPanel.TabBar [Output/Diff/Events/Costs]` | ◐ | RunInspector tabs are `Live Output / Events / Skills / Preset (conditional)` (`RunInspector.js:211+`). Diff and Costs missing. Spec doesn't anticipate Skills/Preset — those are v3 additions to keep. |
| `SessionDetailPanel.ActionBar` state-conditional buttons | ◐ | Cancel + Send Input present; Retry / Pause / Resume / Apply changes missing |

### 2.5 Manager Backend (§11.4, §17, §18)

| Endpoint / table / event | Status | Notes |
|---|---|---|
| `POST /api/manager/chat` | ◐ | `POST /api/manager/message` (`routes/manager.js:542`) is a Top-only alias for sending a user message; PM-scoped sending goes through `POST /api/conversations/:id/message`. The spec's `manager:plan` structured response + approval flow is absent — the route is an alias for *sending*, not an equivalent for *the chat contract*. |
| `POST /api/manager/start` | ✅ (beyond spec) | Not in spec but needed for agent profile bootstrap |
| `GET /api/manager/history` | ✗ | History lives in `run_events` queried by `GET /api/manager/events` — different shape, no dedicated manager-history endpoint |
| `POST /api/manager/execute-plan` | ✗ | No plan workflow at all |
| `POST /api/manager/respond-to-agent` | ✗ | Agent input goes via `/api/conversations/worker:<id>/message` (parent-notice model). Behavior is reachable, naming is different. |
| `GET /api/manager/summary` | ✗ | Nothing aggregates active/needs_input/failed/cost into a single structured response; UI computes it client-side from `runs` list |
| `GET /api/manager/status` | ✅ (beyond spec) | Exists for liveness + PM list |
| Table `manager_messages` | ✗ | Manager conversation is stored as `run_events` on the manager run — works fine, but doesn't match spec schema |
| Table `manager_plans` + `plan_runs` | ✗ | — |
| SSE `manager:message` | ◐ | Current channels: `run:status`, `run:completed`, `run:needs_input`, `dispatch_audit:recorded`. Manager text arrives through `mgr.assistant_message` / `assistant_text` run_events — different channel, same info. |
| SSE `manager:plan` | ✗ | — |
| SSE `manager:summary` | ✗ | — |

### 2.6 Interaction Flows (§10)

| Flow | Status | Notes |
|---|---|---|
| §10.1 User asks Manager to fix tests | ◐ | Chat send works; there is no ActionPlanCard / approval step — Manager text includes the plan inline, user approves via natural language, worker runs get spawned by Manager's tool calls. Functional but non-structured. |
| §10.2 Agent asks for input → attention routing | ◐ | SSE `run:needs_input` fires browser notification + tab pulse; Attention Badge missing, SessionCard pulse missing, Attention Strip on Manager view missing |
| §10.3 Agent fails → recovery via Manager chat | ✅ | Natural language recovery via Manager is working today |
| §10.4 "지금 상태가 어때?" status query | ◐ | Manager answers from context, but no structured summary card; just prose |

### 2.7 Data & Event Additions (§17, §18)

All three proposed tables (`manager_messages`, `manager_plans`, `plan_runs`) are missing. The current model stores manager conversation as events on a single long-lived manager run, which is simpler and fits the existing `runService` / `conversationService` contract. Adding the spec tables would be a refactor, not a net-new capability, and should only happen if the Plan Workflow actually ships.

### 2.8 Scope Adjustments (Out)

Items to explicitly drop or defer from the spec:

| Spec item | Decision | Reason |
|---|---|---|
| `manager_messages`/`manager_plans` as separate tables | ⊘ Defer (not "never") | Current `run_events`-on-manager-run model (`conversationService.js:425+`) covers storage and replay but has weak support for structured-plan joins (no schema for `plan_id → [run_ids]` relationships, no status field for pending/approved/executed). If Plan Workflow (R2-C follow-up) ships with real approval UX, `manager_plans` + `plan_runs` may need to land as a separate schema rather than shoehorning JSON blobs into `run_events.payload_json`. Decision: defer, revisit when Plan Workflow has concrete UX requirements. |
| Dashboard removal (Open Q #4) | ⊘ Keep Dashboard | Dashboard's `triage-feed` is a working Attention Strip and serves users who want a read-only overview without the Chat panel. Recommendation: keep both, move ManagerView to default landing. |
| `POST /api/manager/respond-to-agent` as distinct endpoint | ⊘ Map to existing path | `/api/conversations/worker:<id>/message` is the first-class path; spec's endpoint is a duplicate with a worse name. |

## 3. Phase Breakdown (shippable increments)

The original spec proposed Phase A / B / C (1w + 1w + 0.5w). Given what's already built, the residual is:

### R2-A: Attention Surface Lift (shipping: 3–4 days)

*Purpose*: move the attention routing spec requires from Dashboard into ManagerView's right panel. High user-value, low risk.

- **R2-A.1** `AttentionBadge` in NavSidebar
  - Derived count from `runs.filter(r => r.status === 'needs_input' || r.status === 'failed')`
  - Badge pulse animation on count change
  - Hides when count = 0
- **R2-A.2** Extract an attention-scoped `AttentionStrip` from DashboardView's `triage-feed`
  - Current `triage-feed` is a superset (manager/running/review/overdue/due-soon); extracting verbatim would pollute ManagerView's right panel
  - New component: attention-only (needs_input + failed), hide-when-empty per spec §12.1
  - Keep DashboardView's existing `triage-feed` intact (no regression on the Dashboard page)
- **R2-A.3** Render `AttentionStrip` at top of SessionGrid (right panel)
  - Insert above the "Task Sessions" header
  - Same click → RunInspector open behavior
- **R2-A.4** (deferrable) Pulse/breathe animation on SessionCard status dot
  - Add CSS classes per spec §14.2 (`status-dot-input`, `status-dot-running`, `status-dot-failed`)
  - Blocked on R2-A.3 rendering a flat run-card list — current SessionGrid shows task-level summaries only, so "card with status dot" has no host to animate. Bundle with R2-B if we commit to run-level cards, otherwise drop this sub-item.

**Deliverable**: user sees needs_input/failed on ManagerView without clicking Dashboard; attention count is visible in sidebar.

**Non-goals**: don't touch SessionGrid's project grouping; don't introduce plan workflow.

### R2-B: Session Detail as Slide-over + Tab Additions (shipping: 2–3 days)

*Purpose*: spec §8.3 slide-over + missing tabs. Moderate risk (RunInspector is heavy).

- **R2-B.1** Convert `RunInspector` from modal to slide-over panel
  - CSS change + layout wrapper; no behavior change
  - Keep current backdrop/Escape close semantics
- **R2-B.2** Add `Diff` tab
  - New `GET /api/runs/:id/diff` endpoint returning unified diff for the run's worktree
  - Leverages existing `worktreeService` — no new auth surface
- **R2-B.3** Add `Costs` tab
  - Source: `runs.cost_usd` column (Claude Code worker path, populated from `result.total_cost_usd` — see `streamJsonEngine.js:375`) + Codex manager `mgr.usage` events (see `codexAdapter.js:585`). NOT from `run_events.token_usage` — that channel does not exist.
  - Tab surfaces `runs.cost_usd` as the headline + a breakdown from manager `mgr.usage` events when present
  - Empty state: "Cost data not available for this adapter" when `runs.cost_usd IS NULL` (OpenCode / non-emitting paths)

**Deliverable**: SessionDetail matches spec §13 tab coverage; opens as slide-over.

**Non-goals**: ActionBar state-conditional buttons beyond current Cancel/Send — retry/pause/apply are separate phases since they touch lifecycleService.

### R2-C: Manager UX polish — Suggested Actions + Summary Endpoint (shipping: 2 days)

*Purpose*: fill the "Manager asks structured questions" gap without committing to ActionPlanCard's full approval workflow (too speculative without user feedback).

- **R2-C.1** `GET /api/manager/summary`
  - Returns `{ active, needs_input, failed, completed_today, total_cost_today }`
  - Pure aggregation over `runs` + `run_events`, no LLM
- **R2-C.2** `SuggestedActions` strip above ChatInput
  - Hardcoded rules based on current run states (spec §11.2 table)
  - Rules: `needs_input > 0 → [Respond to Agent-X]`, `failed > 0 → [Retry Agent-Y]`, `all idle → [New Task]`
  - Click → pre-fills ChatInput with suggested prompt; user confirms
- **R2-C.3** (stretch) Manager view as default landing
  - app.js route fallback change from `dashboard` to `manager`
  - User can still navigate to Dashboard; only the entry path changes
  - Defer if there's user pushback on changing the first-touch surface

**Deliverable**: Manager feels more interactive without building a plan-approval workflow.

**Non-goals**: no ActionPlanCard, no `manager_plans` table. Those wait for explicit user demand.

### Deferred / out of this cycle

- ActionPlanCard + `POST /api/manager/execute-plan` — requires user research on whether current natural-language approval is insufficient. Revisit after R2-C ships and we have usage data.
- Mobile `<768px` readonly layout — low priority per spec §2 persona ranking; schedule only after we know mobile access is actually being used.
- Drag-to-resize Chat/Overview split — UX nice-to-have, zero functional gap.
- `manager_messages` / `manager_plans` tables — do not introduce unless Plan Workflow ships.

## 4. Risks & Open Questions (Revised)

Spec §21 listed five Open Questions. Status update on each:

1. **Manager LLM choice** — already decided per-agent-profile. No longer an open question; `ManagerChat` picker reads `MANAGER_PROFILE_TYPES = ['claude-code', 'codex']` from `ManagerChat.js:20`.
2. **Conversation persistence** — already `run_events`-backed (durable across restart). Decision: SQLite, resolved by v3.
3. **Autopilot** — still explicitly out of scope; no change.
4. **Dashboard replacement** — revised decision above: **keep both**, default to Manager. Dashboard's TriageFeed serves as a read-only overview.
5. **Manager response language** — system prompt in repo uses Korean (CLAUDE.md convention). Behavioral; spec alignment not a code issue.

**New risk** not in the original spec: **attention-source drift**. M3 added `mcp_template_drift` events and Phase 7 added `dispatch_audit:recorded`. Any AttentionBadge / TriageFeed must cross-count these drift incidents or users end up with two parallel "warning" surfaces (current sidebar DriftDrawer badge + future AttentionBadge). Recommendation: **unify under one badge** when R2-A.1 ships — AttentionBadge count = needs_input + failed + unread drift.

## 5. Recommendation

Ship **R2-A** as the next concrete phase (2–3 days). It moves the needle on the spec's headline goal ("attention routing > chat viewer") with minimum risk, reuses the existing TriageFeed implementation, and unblocks user testing before committing to R2-B / R2-C.

If user feedback after R2-A says "the plan approval thing is a real pain point", then ActionPlanCard becomes worth building. Otherwise, the natural-language approval loop that works today is likely sufficient.

Scale-L in the original spec → **M (0.8–1.1 week)** in revised phases, because v3 multi-layer manager already shipped the structural half of the work. (Revised upward from earlier 0.7–1.0 week draft after Codex review pointed out that SessionGrid is further from spec §12.2 than initially estimated and that R2-A.4's pulse animation has no host card to animate without SessionCard work bundled in.)

---

## Appendix: Codex cross-review (2026-04-23)

Partial review (rate-limited at minute 4.5) produced the following corrections, all reflected above:

- `triage-feed` is a superset of spec's AttentionStrip, not a direct equivalent — §1, §2.1, §3/R2-A.2 updated.
- SessionGrid shows task summaries only, not run cards — §2.4 re-rated ✗; R2-A.4 marked deferrable.
- RunInspector tabs are `Live Output / Events / Skills / Preset (conditional)` — §2.4 corrected.
- `/api/manager/message` is a Top-only *send* alias, not a `chat contract equivalent` — §2.5 reworded.
- `manager_messages` drop softened to "defer, revisit on Plan Workflow UX decision" — §2.8 reworded.
- R2-B.3 cost source is `runs.cost_usd` + manager `mgr.usage`, not `run_events.token_usage` — §3/R2-B.3 corrected.

Un-reviewed (due to rate limit):
- Risks section 4 (attention-source drift unification feasibility)
- Final recommendation (§5)

These sections are unchanged since Codex did not flag them before its session ended; re-review can happen when merging the next slice of backlog work.

