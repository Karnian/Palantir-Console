import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const {
  createMemoryComposer,
  kindRank,
} = require('../services/memoryComposer');
const { createConversationService } = require('../services/conversationService');

function makeAdapter({ items = [], headerLabel = 'Mock', revision = 1 } = {}) {
  return {
    retrieve: (_id, _opts) => items,
    buildBlock: (rows) => rows.length ? `## ${headerLabel}\n${rows.map(r => r.content).join('\n')}` : null,
    getRevision: () => revision,
  };
}

function makeItem({
  id,
  kind = 'fact',
  content,
  fact_key = null,
  content_hash,
  origin = 'human',
  confidence = 0.8,
  importance = 5,
  revision = 1,
} = {}) {
  return {
    id,
    kind,
    content,
    fact_key,
    content_hash: content_hash ?? `hash:${id}`,
    origin,
    confidence,
    importance,
    revision,
  };
}

function makeComposer({ userItems = [], workspaceItems = [], userRevision = 1, workspaceRevision = 1 } = {}) {
  return createMemoryComposer({
    retrievers: {
      user: makeAdapter({ items: userItems, headerLabel: 'User Memory', revision: userRevision }),
      workspace: makeAdapter({ items: workspaceItems, headerLabel: 'Learned Memory', revision: workspaceRevision }),
    },
  });
}

function multiOwnerCompose(opts = {}) {
  return makeComposer(opts).compose({
    owners: [
      { owner_type: 'user', owner_id: 'user', provenance: 'user' },
      { owner_type: 'workspace', owner_id: 'proj1' },
    ],
    taskContext: 'node runtime',
  });
}

function countInBlock(block, text) {
  return (block || '').split(text).length - 1;
}

function makeComposition(owners) {
  return {
    fingerprint: `fp:${owners.map(o => `${o.owner_type}:${o.owner_id}`).join(',')}`,
    owner_states: owners.map((owner, index) => ({
      owner_type: owner.owner_type,
      owner_id: owner.owner_id,
      provenance: owner.provenance ?? null,
      revision: index + 1,
      selected_set_hash: `selected:${index}`,
      suppressed_set_hash: null,
      selected_count: 1,
      suppressed_count: 0,
      budget_limit: 1000000,
      budget_used: 1,
    })),
    item_edges: [],
    composer_version: '0.1.0',
    policy_version: '0.1.0',
    retrieval_query_hash: null,
    token_budget: 1000000,
    owner_vector_hash: 'owners',
    selected_set_hash: 'selected',
  };
}

function makePmHarness({
  memoryMultiOwner,
  workspaceRevision = 1,
  userRevision = 1,
  shouldCompose,
} = {}) {
  const adapterCalls = [];
  const adapter = {
    runTurn(runId, payload) {
      adapterCalls.push({ runId, payload });
      return { accepted: true };
    },
  };
  const run = {
    id: 'run-pm-1',
    is_manager: true,
    manager_layer: 'pm',
    conversation_id: 'pm:proj1',
    manager_adapter: 'mock',
    status: 'running',
    parent_run_id: null,
  };
  const composerCalls = [];
  const ledgerCalls = [];
  const memoryComposer = {
    compose(arg) {
      composerCalls.push(arg);
      return {
        block: '## Mock Memory\nservice-layer memory',
        composition: makeComposition(arg.owners),
      };
    },
  };
  const compositionLedger = {
    shouldCompose(arg) {
      ledgerCalls.push(arg);
      return shouldCompose ? shouldCompose(arg) : { compose: true, reason: 'test' };
    },
    commitAccepted() {},
  };
  const svc = createConversationService({
    runService: {
      updateRunStatus() {},
      getRunEvents: () => [],
    },
    managerRegistry: {
      probeActive: () => run,
      getActiveAdapter: () => adapter,
      getActiveRunId: () => null,
    },
    managerAdapterFactory: { getAdapter: () => adapter },
    lifecycleService: { sendAgentInput: () => true },
    memoryService: { getRevision: () => workspaceRevision },
    masterMemoryService: { getRevision: () => userRevision },
    memoryMultiOwner,
    memoryComposer,
    compositionLedger,
    logger: () => {},
  });
  return { svc, adapterCalls, composerCalls, ledgerCalls };
}

describe('memory composer multi-owner', () => {
  test('KIND_RANK total order', () => {
    assert.ok(kindRank('constraint') < kindRank('commitment'));
    assert.ok(kindRank('commitment') < kindRank('decision'));
    assert.ok(kindRank('decision') < kindRank('fact'));
    assert.ok(kindRank('fact') < kindRank('pattern'));
    assert.ok(kindRank('pattern') < kindRank('heuristic'));
    assert.ok(kindRank('heuristic') < kindRank('preference'));
    assert.ok(kindRank('preference') < kindRank('totally-unknown-xyz'));
  });

  test('Comparator: kind beats owner', () => {
    const result = multiOwnerCompose({
      userItems: [
        makeItem({ id: 'u-fact', kind: 'fact', fact_key: 'runtime.node', content: 'User says Node v20', content_hash: 'h-user' }),
      ],
      workspaceItems: [
        makeItem({ id: 'w-constraint', kind: 'constraint', fact_key: 'runtime.node', content: 'Workspace requires Node v22', content_hash: 'h-workspace' }),
      ],
    });

    assert.match(result.block, /Workspace requires Node v22/);
    assert.doesNotMatch(result.block, /User says Node v20/);
    assert.equal(result.composition.item_edges[0].item_id, 'w-constraint');
  });

  test('Comparator: same kind uses owner tiebreak', () => {
    const result = multiOwnerCompose({
      userItems: [
        makeItem({ id: 'u-fact', kind: 'fact', fact_key: 'runtime.node', content: 'User says Node v20', content_hash: 'h-user' }),
      ],
      workspaceItems: [
        makeItem({ id: 'w-fact', kind: 'fact', fact_key: 'runtime.node', content: 'Workspace says Node v22', content_hash: 'h-workspace' }),
      ],
    });

    assert.match(result.block, /User says Node v20/);
    assert.doesNotMatch(result.block, /Workspace says Node v22/);
    assert.equal(result.composition.item_edges[0].item_id, 'u-fact');
  });

  test('Dedup: same fact_key same value', () => {
    const result = multiOwnerCompose({
      userItems: [
        makeItem({ id: 'u-node', fact_key: 'runtime.node', content: 'Node is v20', content_hash: 'same-node' }),
      ],
      workspaceItems: [
        makeItem({ id: 'w-node', fact_key: 'runtime.node', content: 'Node is v20', content_hash: 'same-node' }),
      ],
    });

    assert.equal(countInBlock(result.block, 'Node is v20'), 1);
    assert.equal(result.composition.item_edges.filter(e => e.decision === 'deduped').length, 1);
  });

  test('Dedup: null fact_key same content_hash', () => {
    const result = multiOwnerCompose({
      userItems: [
        makeItem({ id: 'u-hash', fact_key: null, content: 'Shared formatting rule', content_hash: 'same-content' }),
      ],
      workspaceItems: [
        makeItem({ id: 'w-hash', fact_key: null, content: 'Shared formatting rule', content_hash: 'same-content' }),
      ],
    });

    assert.equal(countInBlock(result.block, 'Shared formatting rule'), 1);
    assert.equal(result.composition.item_edges.filter(e => e.decision === 'deduped').length, 1);
  });

  test('Conflict: same fact_key different content is silently suppressed', () => {
    const result = multiOwnerCompose({
      userItems: [
        makeItem({ id: 'u-node', fact_key: 'env.node', content: 'Node runtime is v20', content_hash: 'node-v20' }),
      ],
      workspaceItems: [
        makeItem({ id: 'w-node', fact_key: 'env.node', content: 'Node runtime is v22', content_hash: 'node-v22' }),
      ],
    });

    assert.match(result.block, /Node runtime is v20/);
    assert.doesNotMatch(result.block, /Node runtime is v22/);
    const conflicted = result.composition.item_edges.find(e => e.decision === 'conflicted');
    assert.ok(conflicted);
    assert.equal(conflicted.item_id, 'w-node');
    assert.doesNotMatch(result.block, /conflict/i);
  });

  test('Budget: lower-precedence owner rows are truncated by owner cap while user rows fit', () => {
    const userItems = Array.from({ length: 5 }, (_, i) => makeItem({
      id: `u-${i}`,
      fact_key: `user.${i}`,
      content: `User preference ${i}`,
      content_hash: `u-h-${i}`,
    }));
    const workspaceItems = Array.from({ length: 40 }, (_, i) => makeItem({
      id: `w-${i}`,
      fact_key: `workspace.${i}`,
      content: `Workspace memory ${i} ${'x'.repeat(420)}`,
      content_hash: `w-h-${i}`,
    }));

    const result = multiOwnerCompose({ userItems, workspaceItems });
    const userEdges = result.composition.item_edges.filter(e => e.source_owner_type === 'user');
    const workspaceBudgetEdges = result.composition.item_edges.filter(e =>
      e.source_owner_type === 'workspace' && e.decision === 'budget_exceeded'
    );

    assert.equal(userEdges.length, userItems.length);
    assert.ok(userEdges.every(e => e.decision === 'included'));
    assert.ok(workspaceBudgetEdges.length > 0);
    assert.ok(workspaceBudgetEdges.every(e => /budget_limit=3000/.test(e.reason)));
  });

  test('Block assembly: User before Workspace', () => {
    const result = multiOwnerCompose({
      userItems: [
        makeItem({ id: 'u-only', content: 'User scoped memory', content_hash: 'u-only' }),
      ],
      workspaceItems: [
        makeItem({ id: 'w-only', content: 'Workspace scoped memory', content_hash: 'w-only' }),
      ],
    });

    assert.ok(result.block.indexOf('## User Memory') < result.block.indexOf('## Learned Memory'));
  });

  test('Single-owner byte-equivalence', () => {
    const items = [
      makeItem({ id: 'w-1', kind: 'constraint', content: 'Keep this exact block line', content_hash: 'w-1' }),
      makeItem({ id: 'w-2', kind: 'heuristic', content: 'And keep this one too', content_hash: 'w-2' }),
    ];
    const adapter = makeAdapter({ items, headerLabel: 'Learned Memory', revision: 7 });
    const reference = createMemoryComposer({ retrievers: { workspace: adapter } }).compose({
      owners: [{ owner_type: 'workspace', owner_id: 'proj1' }],
      taskContext: 'exact block',
    });
    const actual = createMemoryComposer({
      retrievers: {
        workspace: adapter,
        user: makeAdapter({ items: [], headerLabel: 'User Memory' }),
      },
    }).compose({
      owners: [{ owner_type: 'workspace', owner_id: 'proj1' }],
      taskContext: 'exact block',
    });

    assert.deepEqual(actual, reference);
    assert.equal(actual.block, adapter.buildBlock(items));
    assert.equal(actual.composition.owner_states.length, 1);
    assert.deepEqual(actual.composition.item_edges.map(e => e.decision), ['included', 'included']);
  });
});

describe('conversation service PM multi-owner wiring', () => {
  test('Flag OFF passes only workspace owner to compose', () => {
    const harness = makePmHarness({ memoryMultiOwner: false, workspaceRevision: 4, userRevision: 9 });

    harness.svc.sendMessage('pm:proj1', { text: 'ship it' });

    assert.equal(harness.ledgerCalls.length, 1);
    assert.deepEqual(harness.ledgerCalls[0].currentOwnerRevisions, [
      { owner_type: 'workspace', owner_id: 'proj1', revision: 4 },
    ]);
    assert.deepEqual(harness.composerCalls[0].owners, [
      { owner_type: 'workspace', owner_id: 'proj1' },
    ]);
  });

  test('Gate receives 2-owner revision vector and user revision bump composes', () => {
    const priorUserRevision = 1;
    const harness = makePmHarness({
      memoryMultiOwner: true,
      workspaceRevision: 3,
      userRevision: 2,
      shouldCompose(arg) {
        const userRevision = arg.currentOwnerRevisions.find(r => r.owner_type === 'user')?.revision;
        return {
          compose: userRevision > priorUserRevision,
          reason: `revision_increased:user:user:${priorUserRevision}->${userRevision}`,
        };
      },
    });

    harness.svc.sendMessage('pm:proj1', { text: 'ship it' });

    assert.equal(harness.ledgerCalls.length, 1);
    assert.deepEqual(harness.ledgerCalls[0].currentOwnerRevisions, [
      { owner_type: 'workspace', owner_id: 'proj1', revision: 3 },
      { owner_type: 'user', owner_id: 'user', provenance: 'user', revision: 2 },
    ]);
    assert.deepEqual(harness.composerCalls[0].owners, [
      { owner_type: 'user', owner_id: 'user', provenance: 'user' },
      { owner_type: 'workspace', owner_id: 'proj1' },
    ]);
  });
});
