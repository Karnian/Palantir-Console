# Operator profile memory (R4→active, full pipeline) — plan

## Goal (user decision: 전체 저장+주입)
Make an **operator profile** (operator_profiles.id, `op_...`) a first-class memory owner:
R4 remember → candidate → distill/promote → **active in memory_items** → **injected into the
specialist** (owner_type='profile'). This deliberately **reverses the "MVP stateless specialist"
lock** (specialist becomes stateful via profile-owned memory). Initial producer = manual R4
remember (profile-scoped); automatic producers (harvest/R3 for profiles) are future work.

## Ground truth (Explore + schema, file:line verified)
- **memory_items is ALREADY owner-keyed**: migration 033 added `owner_type`/`owner_id`
  (backfilled workspace/project_id). The ONLY DB blocker to a profile row is
  `project_id TEXT NOT NULL REFERENCES projects(id)` (025:18). FK allows NULL.
- **candidates + jobs already accept profile** (migration 042: project_id nullable + coherence
  CHECK `workspace∧project_id=owner_id ∨ profile∧project_id NULL∧owner_id set`).
- **user/master memory is a SEPARATE table** (`master_memory_items`, 030). So per-owner-type
  ACTIVE tables: memory_items = workspace **(and now profile)**, master_memory_items = user.
  → Architecture: **profile goes in memory_items** (it's the owner-keyed active table; profile is
  another owner alongside workspace) — NOT a new table. Consistent with 042 feeding memory_items.
- **memory_items has FTS5 external-content** `memory_fts` (rowid_pk mapping) + 3 triggers
  (ai/ad/au, 025:54-63) + `project_memory_revision` + `pm_memory_injection` refs. A rebuild MUST
  preserve rowid_pk exactly + recreate triggers + FTS rebuild.
- **5 code blocks** are workspace-only today: (1) write entry hardwires {project_id};
  (2) distill scheduler skips non-workspace (`memoryDistillService.js:173`); (3) claim SQL
  matches workspace-only (`memoryService.js:768`); (4) promote → createMemoryItem requires
  projectId (`memoryService.js:325,1065`) + memory_items NOT NULL; (5) no `profile` retriever +
  specialist composes user-only (`specialistService.js:109`).
- operator_profiles.id = owner_id for owner_type='profile' (plain TEXT, NO FK by design).

## Architecture decision
Relax **memory_items** (not a new table): owner cols already exist (033); mirror migration 042's
pattern — project_id nullable + coherence CHECK. The workspace retriever already reads memory_items
by owner, so the profile retriever is the same read with owner_type='profile'.

## Slices
### R4a — schema + storage core (this branch)
- **Migration 044**: rebuild memory_items → project_id **nullable** + coherence CHECK
  (`workspace∧project_id NOT NULL∧owner_id=project_id ∨ profile∧project_id NULL∧owner_id set`),
  owner_type/owner_id **NOT NULL** (all rows backfilled). **Preserve rowid_pk exactly**
  (explicit copy), drop old table (drops triggers), rename, **recreate the 3 FTS triggers**,
  `INSERT INTO memory_fts(memory_fts) VALUES('rebuild')`, recreate indexes. project_memory_revision
  is workspace-scoped — leave as-is (profile promotion won't bump it; revisit in R4c if needed).
- **createMemoryItem**: accept an owner (`{project_id}` OR `{profile_id}`) via normalizeOwner;
  when profile, project_id=NULL, owner_type/owner_id set; don't throw 'projectId required' for
  profile. Keep workspace path byte-identical.
- **Tests**: profile row insert+read; workspace insert unaffected; FTS search still returns
  workspace rows AND finds profile rows; coherence CHECK rejects malformed (workspace w/o
  project_id, profile w/ project_id); rowid_pk/FTS mapping intact after migration on seeded DB.

### R4b — write + promote pipeline
- createCandidate accepts profile owner; **profile-scoped remember**: `POST /api/operator/
  profiles/:id/memory/remember` (actor split cookie=active/bearer=candidate, mirror workspace
  route) — or extend memoryService.remember to key by profile. Distiller scheduler: handle
  profile owners (drop the workspace-only skip). Claim SQL: allow profile jobs. promote:
  createMemoryItem with profile owner. Tests across the pipeline.

### R4c — injection (makes specialist stateful)
- Register a `profile` retriever in memoryComposer (reads memory_items owner_type='profile').
- specialist composes its profile owner (owner_type='profile', owner_id=profileId) alongside user.
- Optional: profile memory read API/MemoryView surface. Tests: specialist injects profile memory;
  empty profile → no injection; user-scope still works.

## Risks
1. **memory_items rebuild** (FTS5 external-content + rowid_pk + triggers + revision) — highest.
   Must preserve rowid_pk and rebuild FTS; a full `node --test` + a seeded-DB migration test guard it.
2. **stateless→stateful specialist** — approved lock reversal; keep user-scope behavior intact,
   profile injection additive.
3. **Producer gap** — MVP producer is manual R4 remember; profile memory stays empty until used.
   Documented; automatic producers are a later track.

## For review (Codex)
- Is relaxing memory_items (vs a separate profile_memory_items like master) the right call given
  the 033 owner-keying + 042 candidate/job precedent?
- Migration 044 FTS5-rebuild safety: rowid_pk preservation, trigger recreation, revision refs,
  and whether `project_memory_revision`/`pm_memory_injection` need profile handling now or later.
- Coherence CHECK exact shape; any WHERE/index that assumes project_id NOT NULL.
- Slicing: is R4a (schema+createMemoryItem) a safe standalone merge (no caller creates profile
  rows yet → additive/inert), or must R4b land together?
