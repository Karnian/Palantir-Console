'use strict';

/**
 * Memory Composer — A2-1 skeleton (미연결, behavior-preserving).
 *
 * 단일 주입 엔트리: owner 리스트를 받아 owner별 retriever+block-builder(기존 로직 재사용)로
 * 주입 블록을 조립하고 3-part 메타데이터(meta-contract LOCK)를 반환한다.
 *
 * 단일 owner 시 현 인라인 주입과 byte-equivalent.
 * DB ledger 無 (A2-2). conversationService 연결 無 (A2-3). behavior-preserving.
 */

const crypto = require('node:crypto');

// ─── 버전 상수 (A2-2 ledger가 이 값으로 persist) ──────────────────────────────
const COMPOSER_VERSION = '0.1.0'; // A2-1 skeleton
const POLICY_VERSION = '0.1.0';   // constraint>fact>heuristic; multi-owner A2-4에서 활성

// ─── 토큰 예산 기본값 ─────────────────────────────────────────────────────────
// token_cost 휴리스틱: ceil(content.length / 4) (chars ÷ avg 4 bytes/token).
// 기본 budget은 단일 owner byte-equivalence를 보장하기 위해 실질적으로 truncate가
// 일어나지 않을 만큼 충분히 큰 값 (CHAR_CAP × TOP_K ≒ 2000×12 = 24000 chars → ~6000 tokens).
// 더 보수적으로 1_000_000을 사용 (오버헤드 없음; DB write 0).
const DEFAULT_BUDGET = 1_000_000;

// ─── kind 우선순위 (precedence policy — 단일 owner에서는 no-op) ──────────────
const KIND_RANK = {
  constraint: 0,
  commitment: 1,
  decision: 2,
  fact: 3,
  pattern: 4,
  heuristic: 5,
  preference: 6,
};
function kindRank(kind) {
  const k = typeof kind === 'string' ? kind.toLowerCase() : '';
  return KIND_RANK[k] ?? 99;
}

const ORIGIN_RANK = { human: 0, batch_llm: 1 };
function originRank(origin) {
  const k = typeof origin === 'string' ? origin.toLowerCase() : '';
  return ORIGIN_RANK[k] ?? 2;
}

const MULTI_OWNER_BUDGET = {
  workspace: 3000,
  user: 1500,
  profile: 1500, // R4c: operator profile owner — bounded like user (specialist injection)
};
const PROVENANCE_BUDGET = {
  user: 1500,
  cross_project: 750,
};
function getOwnerTypeBudget(ownerType) {
  return MULTI_OWNER_BUDGET[ownerType] ?? DEFAULT_BUDGET;
}
function getOwnerBudget(ownerType, provenance) {
  const p = typeof provenance === 'string' ? provenance : '';
  return PROVENANCE_BUDGET[p] ?? getOwnerTypeBudget(ownerType);
}

// ─── 해시 헬퍼 ───────────────────────────────────────────────────────────────
function sha256(text) {
  return crypto.createHash('sha256').update(String(text ?? '')).digest('hex');
}

function hashObject(obj) {
  return sha256(JSON.stringify(obj));
}

// ─── token_cost 휴리스틱 ─────────────────────────────────────────────────────
// ceil(content.length / 4): 영어 평균 ~4 chars/token. 한국어는 더 높지만 conservative 추정.
function estimateTokenCost(content) {
  const len = typeof content === 'string' ? content.length : 0;
  return Math.ceil(len / 4);
}

function numericOrZero(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function compareMultiOwnerRows(a, b) {
  const kindDelta = kindRank(a && a.kind) - kindRank(b && b.kind);
  if (kindDelta !== 0) return kindDelta;

  const ownerDelta = numericOrZero(a && a._ownerIndex) - numericOrZero(b && b._ownerIndex);
  if (ownerDelta !== 0) return ownerDelta;

  const originDelta = originRank(a && a.origin) - originRank(b && b.origin);
  if (originDelta !== 0) return originDelta;

  const confidenceDelta = numericOrZero(b && b.confidence) - numericOrZero(a && a.confidence);
  if (confidenceDelta !== 0) return confidenceDelta;

  const importanceDelta = numericOrZero(b && b.importance) - numericOrZero(a && a.importance);
  if (importanceDelta !== 0) return importanceDelta;

  return numericOrZero(a && a._rank) - numericOrZero(b && b._rank);
}

function itemTableForOwner(ownerType) {
  // R4c: workspace AND profile live in memory_items (migration 044); only user/L2
  // lives in master_memory_items.
  return ownerType === 'user' ? 'master_memory_items' : 'memory_items';
}

function makeItemEdge(row, decision, reason = null) {
  const content = row && typeof row.content === 'string' ? row.content : '';
  return {
    item_table: itemTableForOwner(row && row._ownerType),
    item_id: row && row.id,
    item_revision: row && row.revision,
    content_hash: row && row.content_hash,
    fact_key: row && row.fact_key,
    kind: row && row.kind,
    source_owner_type: row && row._ownerType,
    source_owner_id: row && row._ownerId,
    provenance: row && row._provenance != null ? row._provenance : null,
    decision,
    reason,
    rank: row && row._rank,
    token_cost: estimateTokenCost(content),
  };
}

function stripComposerAnnotations(row) {
  const clean = {};
  for (const [key, value] of Object.entries(row || {})) {
    if (!key.startsWith('_')) clean[key] = value;
  }
  return clean;
}

function multiOwnerGroupKey(row) {
  if (row && row.fact_key != null) return `fact_key:${String(row.fact_key)}`;
  if (row && row.content_hash != null) return `content_hash:${String(row.content_hash)}`;
  return `row:${String(row && row._ownerIndex)}:${String(row && row._rank)}:${String(row && row.id)}`;
}

function rowOwnerKey(row) {
  return `${row && row._ownerType}:${row && row._ownerId}:${row && row._ownerIndex}`;
}

function hasSameContentHash(group) {
  if (!Array.isArray(group) || group.length < 2) return false;
  const firstHash = group[0] && group[0].content_hash;
  if (firstHash == null) return false;
  return group.every((row) => row && row.content_hash === firstHash);
}

function contentDiffers(a, b) {
  const aHash = a && a.content_hash;
  const bHash = b && b.content_hash;
  const hashDiffers = (aHash != null || bHash != null) && aHash !== bHash;
  const textDiffers = String((a && a.content) ?? '') !== String((b && b.content) ?? '');
  return hashDiffers || textDiffers;
}

// ─── Composer factory ────────────────────────────────────────────────────────

/**
 * createMemoryComposer({ retrievers })
 *
 * retrievers: { [owner_type: string]: Adapter }
 *
 * Adapter shape:
 *   retrieve(ownerId, opts) → row[]
 *   buildBlock(rows) → string | null
 *   getRevision(ownerId) → number
 *
 * Built-in adapters (workspace / user) wrap existing memoryService /
 * masterMemoryService methods WITHOUT re-implementing sanitize/format/CHAR_CAP/
 * injection logic — those are fully delegated to the existing buildInjectionBlock.
 */
function createMemoryComposer({ retrievers = {} } = {}) {
  /**
   * compose({ owners, taskContext, mode, slotKind })
   *
   * owners: [{ owner_type, owner_id, provenance?, budget? }]
   *   정책 순서(index)대로 처리.
   * taskContext: string — retrieval query + fingerprint 재료.
   * mode: string — (미래 mode-aware policy 용, 현재 미사용).
   * slotKind: string — (미래 slot 구분 용, 현재 미사용).
   *
   * 반환: { block, composition: { fingerprint, owner_states, item_edges,
   *                                composer_version, policy_version } }
   * never-throws: 실패 시 { block: null, composition: null }.
   */
  /**
   * NOTE on decision semantics (A2-2 ledger, read this):
   *
   *   item_edges.decision='included' means the row was **selected-for-block**
   *   (i.e., passed to adapter.buildBlock). It does NOT guarantee the row
   *   actually appears in the emitted block string — buildInjectionBlock may
   *   internally re-skip injection-marked / empty rows. A2-2 ledger must
   *   store 'included' as "selected", not "emitted".
   *
   *   selected_set_hash / fingerprint is **selection-identity** — it captures
   *   which item id-set was passed to buildBlock, not content-identity.
   *   If the same ids have in-place content changes, fingerprint is unchanged;
   *   item_edges.content_hash (per-row) is the audit truth for content drift.
   */
  function compose(arg) {
    try {
      const { owners = [], taskContext = '', mode, slotKind } =
        (arg != null && typeof arg === 'object') ? arg : {};
      const ownerList = Array.isArray(owners) ? owners : [];
      const isMultiOwner = ownerList.length > 1;

      if (!isMultiOwner) {
      // ── per-owner 처리 ────────────────────────────────────────────────────
      const ownerBlocks = [];
      const ownerStates = [];
      const itemEdges = [];

      for (const ownerSpec of ownerList) {
        const { owner_type, owner_id, provenance, budget: ownerBudget } = ownerSpec || {};
        const adapter = retrievers[owner_type];
        if (!adapter) continue;

        const effectiveBudget = (typeof ownerBudget === 'number' && ownerBudget > 0)
          ? ownerBudget
          : DEFAULT_BUDGET;

        // revision (snapshot at compose time)
        let revision = 0;
        try { revision = adapter.getRevision(owner_id, provenance) ?? 0; } catch { /* non-critical */ }

        // retrieve — within-owner row 순서 불변 (재정렬 금지)
        let rows = [];
        try {
          rows = adapter.retrieve(owner_id, { taskContext, provenance }) ?? [];
        } catch {
          rows = [];
        }
        if (!Array.isArray(rows)) rows = [];

        // per-owner budget application (token cap; 초과분 truncate → edge reason)
        let budgetUsed = 0;
        const selectedRows = [];
        const suppressedIds = new Set();

        // Budget policy: prefix-truncation.
        // Retrieval is relevance-ordered (FTS bm25 + importance), so the most
        // relevant rows come first. Once the budget is first exceeded we suppress
        // that row AND all subsequent rows — we do NOT skip it and continue
        // looking for cheaper rows (first-fit). This preserves relevance ordering
        // and matches the comment "remaining rows suppress".
        // With the default budget (1_000_000 tokens) truncation never fires for
        // realistic data, so single-owner byte-equivalence is maintained.
        let budgetBreached = false;

        for (let rank = 0; rank < rows.length; rank++) {
          const row = rows[rank];
          const content = row && typeof row.content === 'string' ? row.content : '';
          const cost = estimateTokenCost(content);

          if (!budgetBreached && budgetUsed + cost <= effectiveBudget) {
            // Still within budget: include this row.
            selectedRows.push(row);
            budgetUsed += cost;
            itemEdges.push({
              item_table: itemTableForOwner(owner_type),
              item_id: row && row.id,
              item_revision: row && row.revision,
              content_hash: row && row.content_hash,
              fact_key: row && row.fact_key,
              kind: row && row.kind,
              source_owner_type: owner_type,
              source_owner_id: owner_id,
              provenance: provenance ?? null,
              // 'included' = selected-for-block (passed to buildBlock).
              // Does NOT guarantee emission — buildInjectionBlock may re-skip.
              decision: 'included',
              reason: null,
              rank,
              token_cost: cost,
            });
          } else {
            // Budget first exceeded here (or already breached): suppress this row
            // and all subsequent rows (prefix-truncation, no first-fit).
            budgetBreached = true;
            suppressedIds.add(row && row.id);
            itemEdges.push({
              item_table: itemTableForOwner(owner_type),
              item_id: row && row.id,
              item_revision: row && row.revision,
              content_hash: row && row.content_hash,
              fact_key: row && row.fact_key,
              kind: row && row.kind,
              source_owner_type: owner_type,
              source_owner_id: owner_id,
              provenance: provenance ?? null,
              decision: 'budget_exceeded',
              reason: `budget_limit=${effectiveBudget} budget_used=${budgetUsed} token_cost=${cost}`,
              rank,
              token_cost: cost,
            });
          }
        }

        // buildBlock — 기존 buildInjectionBlock 재사용 (sanitize/format/header 전부 위임)
        let ownerBlock = null;
        try {
          ownerBlock = adapter.buildBlock(selectedRows, { provenance });
        } catch { /* annotate-only */ }

        // owner 블록 수집 (null이면 push 안 함)
        if (ownerBlock != null) {
          ownerBlocks.push(ownerBlock);
        }

        // set hashes for ledger contract
        const selectedSetHash = hashObject(selectedRows.map((r) => r && r.id));
        const suppressedSetHash = suppressedIds.size > 0
          ? hashObject(Array.from(suppressedIds))
          : null;

        ownerStates.push({
          owner_type,
          owner_id,
          provenance: provenance ?? null,
          revision,
          selected_set_hash: selectedSetHash,
          suppressed_set_hash: suppressedSetHash,
          selected_count: selectedRows.length,
          suppressed_count: suppressedIds.size,
          budget_limit: effectiveBudget,
          budget_used: budgetUsed,
        });
      }

      // ── 단일 vs 다중 owner block 조합 ────────────────────────────────────
      // 단일 owner: buildBlock 출력 그대로 (추가 wrapping 0) → byte-equivalent.
      // 다중 owner: precedence 순 '\n\n' 결합.
      let block;
      if (ownerBlocks.length === 0) {
        block = null;
      } else if (ownerBlocks.length === 1) {
        block = ownerBlocks[0];
      } else {
        block = ownerBlocks.join('\n\n');
      }

      // ── 3-part 메타데이터 ────────────────────────────────────────────────
      const retrievalQueryHash = sha256(typeof taskContext === 'string' ? taskContext : '');
      const totalBudget = ownerList.reduce((s, o) => {
        const b = o && typeof o.budget === 'number' && o.budget > 0 ? o.budget : DEFAULT_BUDGET;
        return s + b;
      }, 0);
      const ownerVectorHash = hashObject(ownerList.map((o) => o && [o.owner_type, o.owner_id, o.provenance ?? null]));
      // selected_set_hash = **selection-identity**: hash of the id-set passed to
      // buildBlock. Same ids with different content → same hash (content drift is
      // tracked per-row via item_edges.content_hash). A2-2 ledger uses this to
      // detect selection changes between compose() calls on the same context.
      const selectedSetHash = hashObject(
        itemEdges.filter((e) => e.decision === 'included').map((e) => e.item_id)
      );

      // fingerprint = selection-identity hash (see selected_set_hash note above).
      // Changes when: taskContext, owner list, budget limits, or selected id-set changes.
      // Does NOT change when item content changes in-place (same id, different content).
      const fingerprint = sha256(JSON.stringify({
        composer_version: COMPOSER_VERSION,
        policy_version: POLICY_VERSION,
        retrieval_query_hash: retrievalQueryHash,
        token_budget: totalBudget,
        owner_vector_hash: ownerVectorHash,
        selected_set_hash: selectedSetHash,
      }));

      return {
        block,
        composition: {
          fingerprint,
          owner_states: ownerStates,
          item_edges: itemEdges,
          composer_version: COMPOSER_VERSION,
          policy_version: POLICY_VERSION,
          retrieval_query_hash: retrievalQueryHash,
          token_budget: totalBudget,
          owner_vector_hash: ownerVectorHash,
          selected_set_hash: selectedSetHash,
        },
      };
      }

      // ── multi-owner 처리 (A2-4a) ─────────────────────────────────────────
      const ownerStates = [];
      const itemEdges = [];
      const ownerBlocks = [];
      const flatRows = [];
      const ownerMetas = [];
      const ownerMetaByIndex = new Map();

      for (let ownerIndex = 0; ownerIndex < ownerList.length; ownerIndex++) {
        const ownerSpec = ownerList[ownerIndex] || {};
        const { owner_type, owner_id, provenance } = ownerSpec;
        const adapter = retrievers[owner_type];
        if (!adapter) continue;

        const effectiveBudget = getOwnerBudget(owner_type, provenance);

        let revision = 0;
        try { revision = adapter.getRevision(owner_id, provenance) ?? 0; } catch { /* non-critical */ }

        let rows = [];
        try {
          rows = adapter.retrieve(owner_id, { taskContext, provenance }) ?? [];
        } catch {
          rows = [];
        }
        if (!Array.isArray(rows)) rows = [];

        const ownerMeta = {
          owner_type,
          owner_id,
          provenance: provenance ?? null,
          adapter,
          ownerIndex,
          revision,
          effectiveBudget,
          selectedRows: [],
          suppressedIds: new Set(),
          budgetUsed: 0,
        };
        ownerMetas.push(ownerMeta);
        ownerMetaByIndex.set(ownerIndex, ownerMeta);

        for (let rank = 0; rank < rows.length; rank++) {
          const row = rows[rank];
          const base = row != null && typeof row === 'object' ? row : {};
          flatRows.push({
            ...base,
            _ownerType: owner_type,
            _ownerId: owner_id,
            _provenance: provenance ?? null,
            _ownerIndex: ownerIndex,
            _rank: rank,
          });
        }
      }

      flatRows.sort(compareMultiOwnerRows);

      const groupedRows = new Map();
      for (const row of flatRows) {
        const key = multiOwnerGroupKey(row);
        const group = groupedRows.get(key) || [];
        group.push(row);
        groupedRows.set(key, group);
      }

      const winnerRows = [];
      const edgeRecords = [];

      for (const group of groupedRows.values()) {
        if (group.length <= 1) {
          winnerRows.push(...group);
          continue;
        }

        const ownerKeys = new Set(group.map(rowOwnerKey));
        const shouldResolve = ownerKeys.size > 1 || hasSameContentHash(group);
        if (!shouldResolve) {
          winnerRows.push(...group);
          continue;
        }

        const sortedGroup = group.slice().sort(compareMultiOwnerRows);
        const winner = sortedGroup[0];
        winnerRows.push(winner);

        for (const loser of sortedGroup.slice(1)) {
          const sameFactKey = winner && loser &&
            winner.fact_key != null &&
            loser.fact_key != null &&
            winner.fact_key === loser.fact_key;
          const isConflict = sameFactKey && contentDiffers(winner, loser);
          const decision = isConflict ? 'conflicted' : 'deduped';
          const reason = isConflict
            ? `suppressed by winner_id=${winner && winner.id} owner=${winner && winner._ownerType}:${winner && winner._ownerId} fact_key=${winner && winner.fact_key}`
            : `duplicate of winner_id=${winner && winner.id}`;
          edgeRecords.push({ row: loser, edge: makeItemEdge(loser, decision, reason) });
          const loserMeta = ownerMetaByIndex.get(loser && loser._ownerIndex);
          if (loserMeta) loserMeta.suppressedIds.add(loser && loser.id);
        }
      }

      winnerRows.sort(compareMultiOwnerRows);

      for (const ownerMeta of ownerMetas) {
        const rowsForOwner = winnerRows.filter((row) => row && row._ownerIndex === ownerMeta.ownerIndex);
        let budgetBreached = false;

        for (const row of rowsForOwner) {
          const content = row && typeof row.content === 'string' ? row.content : '';
          const cost = estimateTokenCost(content);

          if (!budgetBreached && ownerMeta.budgetUsed + cost <= ownerMeta.effectiveBudget) {
            ownerMeta.selectedRows.push(row);
            ownerMeta.budgetUsed += cost;
            edgeRecords.push({ row, edge: makeItemEdge(row, 'included', null) });
          } else {
            budgetBreached = true;
            ownerMeta.suppressedIds.add(row && row.id);
            edgeRecords.push({
              row,
              edge: makeItemEdge(
                row,
                'budget_exceeded',
                `budget_limit=${ownerMeta.effectiveBudget} budget_used=${ownerMeta.budgetUsed} token_cost=${cost}`,
              ),
            });
          }
        }
      }

      edgeRecords.sort((a, b) => compareMultiOwnerRows(a && a.row, b && b.row));
      for (const record of edgeRecords) itemEdges.push(record.edge);

      for (const ownerMeta of ownerMetas) {
        const selectedRows = ownerMeta.selectedRows.map(stripComposerAnnotations);
        let ownerBlock = null;
        try {
          ownerBlock = ownerMeta.adapter.buildBlock(selectedRows, { provenance: ownerMeta.provenance });
        } catch { /* annotate-only */ }

        if (ownerBlock != null) {
          ownerBlocks.push(ownerBlock);
        }

        const selectedSetHash = hashObject(ownerMeta.selectedRows.map((r) => r && r.id));
        const suppressedSetHash = ownerMeta.suppressedIds.size > 0
          ? hashObject(Array.from(ownerMeta.suppressedIds))
          : null;

        ownerStates.push({
          owner_type: ownerMeta.owner_type,
          owner_id: ownerMeta.owner_id,
          provenance: ownerMeta.provenance,
          revision: ownerMeta.revision,
          selected_set_hash: selectedSetHash,
          suppressed_set_hash: suppressedSetHash,
          selected_count: ownerMeta.selectedRows.length,
          suppressed_count: ownerMeta.suppressedIds.size,
          budget_limit: ownerMeta.effectiveBudget,
          budget_used: ownerMeta.budgetUsed,
        });
      }

      let block;
      if (ownerBlocks.length === 0) {
        block = null;
      } else {
        block = ownerBlocks.join('\n\n');
      }

      const retrievalQueryHash = sha256(typeof taskContext === 'string' ? taskContext : '');
      const totalBudget = ownerList.reduce((s, o) => s + getOwnerBudget(o && o.owner_type, o && o.provenance), 0);
      const ownerVectorHash = hashObject(ownerList.map((o) => o && [o.owner_type, o.owner_id, o.provenance ?? null]));
      const selectedSetHash = hashObject(
        itemEdges.filter((e) => e.decision === 'included').map((e) => e.item_id)
      );

      const fingerprint = sha256(JSON.stringify({
        composer_version: COMPOSER_VERSION,
        policy_version: POLICY_VERSION,
        retrieval_query_hash: retrievalQueryHash,
        token_budget: totalBudget,
        owner_vector_hash: ownerVectorHash,
        selected_set_hash: selectedSetHash,
      }));

      return {
        block,
        composition: {
          fingerprint,
          owner_states: ownerStates,
          item_edges: itemEdges,
          composer_version: COMPOSER_VERSION,
          policy_version: POLICY_VERSION,
          retrieval_query_hash: retrievalQueryHash,
          token_budget: totalBudget,
          owner_vector_hash: ownerVectorHash,
          selected_set_hash: selectedSetHash,
        },
      };
    } catch {
      // never-throws contract: annotate-only (buildInjectionBlock 미러)
      return { block: null, composition: null };
    }
  }

  return { compose };
}

// ─── 내장 adapter 빌더 (팩토리 소비자가 직접 전달하거나 이 헬퍼를 사용) ────

/**
 * buildWorkspaceAdapter(memoryService)
 * workspace owner: memoryService.retrieveForProject + buildInjectionBlock + getRevision.
 * 헤더 "## Learned Memory" (buildInjectionBlock이 emit).
 */
function buildWorkspaceAdapter(memoryService) {
  return {
    retrieve: (ownerId, opts) => memoryService.retrieveForProject(ownerId, opts),
    buildBlock: (rows) => memoryService.buildInjectionBlock(rows),
    getRevision: (ownerId) => memoryService.getRevision(ownerId),
  };
}

/**
 * buildUserAdapter(masterMemoryService)
 * user owner: masterMemoryService.retrieve('user', ownerId, {provenance:'user'}) + buildInjectionBlock + getRevision.
 * 헤더 "## User Memory" (buildInjectionBlock이 emit).
 * provenance는 opts.provenance ?? 'user' — Top inject 경로 동일.
 */
function buildUserAdapter(masterMemoryService) {
  return {
    retrieve: (ownerId, opts) => {
      const o = opts || {};
      return masterMemoryService.retrieve('user', ownerId, {
        ...o,
        provenance: o.provenance ?? 'user',
      });
    },
    buildBlock: (rows, opts) => {
      const provenance = (opts && opts.provenance) ?? 'user';
      const header = provenance === 'cross_project' ? '## Cross-Project Memory' : '## User Memory';
      return masterMemoryService.buildInjectionBlock(rows, { header });
    },
    getRevision: (_ownerId, provenance) => masterMemoryService.getRevision(provenance ?? 'user'),
  };
}

/**
 * buildProfileAdapter(memoryService)
 * profile owner (R4c): memoryService.retrieveForProfile + buildInjectionBlock + getRevision.
 * 헤더 "## Profile Memory". profile 은 revision 테이블이 없어(project_memory_revision 은
 * workspace 전용) getRevision 은 0 을 반환 — specialist 는 ephemeral(one-shot)이라 ledger
 * 캐시 재사용이 없어 무해.
 */
function buildProfileAdapter(memoryService) {
  return {
    retrieve: (ownerId, opts) => memoryService.retrieveForProfile(ownerId, opts),
    buildBlock: (rows) => memoryService.buildInjectionBlock(rows, { header: '## Profile Memory' }),
    getRevision: (ownerId) => memoryService.getRevision(ownerId),
  };
}

module.exports = {
  createMemoryComposer,
  buildWorkspaceAdapter,
  buildUserAdapter,
  buildProfileAdapter,
  // 상수 노출 (테스트 및 A2-2 ledger persist용)
  COMPOSER_VERSION,
  POLICY_VERSION,
  DEFAULT_BUDGET,
  MULTI_OWNER_BUDGET,
  PROVENANCE_BUDGET,
  getOwnerTypeBudget,
  getOwnerBudget,
  kindRank,
};
