# Operator mid-turn delegation — plan (draft for Codex/athena review)

## Goal
A Manager (Top or PM) can invoke the Operator **specialist** DURING its own turn
and use the result inline in the same turn — "매니저가 턴 중 specialist 호출".

## Ground truth (Explore investigation, file:line verified)
- **Managers already call Palantir's REST API mid-turn.** The manager system prompt
  (`managerSystemPrompt.js`) hands them the base URL + bearer token; Codex is told to
  `curl` via Bash, Claude to use `WebFetch` (in its allowlist). They already POST to
  `/api/tasks/:id/execute`, `/api/conversations/:id/message`, `/api/dispatch-audit`.
- **`POST /api/operator/specialist` returns the specialist text synchronously** in the
  response body (`operatorSpecialist.js` → `res.json(result)`, result.text). So a manager
  can `curl`/`WebFetch` it mid-turn, read result.text, and keep reasoning — **genuinely
  within the same turn** (the HTTP call blocks; no turn boundary).
- **The manager's run is `running` for the whole active turn** (Top stays running multi-turn;
  PM flips to running on thread.started). So the manager's OWN run id satisfies the entry
  gate's `ACTIVE_ORIGIN_STATUSES` when passed as `originRunId`.
- **Run id is known at spawn.** PM already gets `pm_run_id` baked into its system prompt
  (used for dispatch-audit). Top gets its run id in prompt context but NOT called out as a
  machine-usable "your run id".
- **No MCP server is hosted by Palantir** (zero MCP SDK / transport / jsonrpc). Building one
  is a large additive effort and is unnecessary — REST already achieves mid-turn delegation.

## Chosen mechanism: enable + document the existing REST path
mid-turn delegation is NOT a new transport; it is making managers *aware and able*:

1. **System prompt guidance** (`managerSystemPrompt.js`, both `top` + `pm` layers,
   **gated on the specialist feature flag** so managers aren't told to curl a 404):
   a short "delegating to a specialist" section — the endpoint, the Contract-A body
   `{ profileId, userText, originRunId: <your run id> }`, that `result.text` is the answer,
   and *when* to use it (a focused, read-only sub-query best handled by a named profile;
   the specialist has no workspace + no tools beyond registry metadata search).
2. **Top run-id exposure**: give the Top manager its own run id in a machine-usable form
   (mirror the PM's `pm_run_id`), so `originRunId` self-reference works for Top too.
3. **Profile discovery**: tell the manager to `GET /api/operator/profiles` to choose a
   `profileId` (route is always mounted, auth-only).

## Rejected alternatives
- **(a) Palantir-hosted MCP server** — no MCP server code exists (zero SDK); large build;
  REST already gives mid-turn. Revisit only if we want the model to call it as a native
  `tool_use` rather than an explicit HTTP step.
- **(b) Engine intercepts model tool_use** — both CLIs execute tools in-subprocess; the
  stream is pass-through/observe-only. No hook to satisfy a tool_use with a server result.
- **(c) Between-turn queue injection** (parent-notice queue) — delivers on the NEXT turn,
  not mid-turn; Codex's single-turn guard forbids a concurrent turn.

## Open questions for review
1. **Blocking duration**: the specialist makes an LLM call (~10-60s). Acceptable to block a
   manager's curl/WebFetch that long? (Managers already make blocking API calls.) Any timeout
   concern in the Claude `WebFetch` / Codex bash path?
2. **Guardrails**: any manager can pass any active manager run as `originRunId` (shared token,
   single-tenant). Is self-reference-only worth enforcing, or is trusted-manager fine (matches
   the existing dispatch-audit model)?
3. **Ergonomics**: is prompt-guidance enough, or do we want structured help (e.g. list the
   available profile names inline in the prompt, or a worked example)? Prompt-only keeps it
   additive + cache-stable.
4. **Cache stability**: `managerSystemPrompt.js` is the cached `model_instructions_file` for
   Codex; adding a static, flag-gated section is fine, but confirm we don't inject anything
   volatile (run id is already injected per-run for PM; Top run id would be too).
5. **Slicing**: is this one slice — (prompt guidance both layers + Top run-id + tests) — or
   should Top run-id exposure be its own micro-slice first?

## Proposed slice (MVP)
**M1**: flag-gated specialist-delegation section in `managerSystemPrompt.js` (top + pm) +
Top run-id exposure + unit tests (prompt contains the section iff flag on; contains the run id).
No new route, no new service — additive, behavior-preserving when the flag is off.
(**M2, optional**: ergonomic polish — inline profile hints / worked example.)
