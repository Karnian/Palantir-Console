// A2a — per-turn codebase context wiring (codebase-pool-memory-axes-brief §5.0).
//
// Verifies:
//   1. resolveTurnCodebaseContext honors the turnMode contract — an explicit
//      'generic' forces a codebase-less turn even for a folder-bound Operator
//      (making the generic branch reachable), while omitted/unknown falls back
//      to the legacy default (codebase via explicit || primary).
//   2. POST /api/conversations/:id/message forwards codebaseProjectId + turnMode
//      to the service (previously silently dropped — Codex A1/R3 finding).

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const request = require('supertest');

const { resolveTurnCodebaseContext } = require('../services/conversationService');
const { createConversationsRouter } = require('../routes/conversations');

test('A2a: resolveTurnCodebaseContext honors the turnMode contract', () => {
  const inst = { instanceId: 'oi_x', primaryProjectId: 'proj_p' };

  // omitted → legacy default: codebase via primary
  const def = resolveTurnCodebaseContext(inst, {});
  assert.equal(def.workspaceProjectId, 'proj_p');
  assert.equal(def.turnMode, null);

  // explicit codebaseProjectId → that codebase
  assert.equal(
    resolveTurnCodebaseContext(inst, { codebaseProjectId: 'proj_other' }).workspaceProjectId,
    'proj_other',
  );

  // turnMode 'generic' forces a codebase-less turn even WITH a primary
  const gen = resolveTurnCodebaseContext(inst, { turnMode: 'generic' });
  assert.equal(gen.workspaceProjectId, null);
  assert.equal(gen.turnMode, 'generic');

  // turnMode 'codebase' + explicit selection
  const cb = resolveTurnCodebaseContext(inst, { turnMode: 'codebase', codebaseProjectId: 'proj_c' });
  assert.equal(cb.workspaceProjectId, 'proj_c');
  assert.equal(cb.turnMode, 'codebase');

  // unknown turnMode is normalized to null (legacy default, non-breaking)
  const unknown = resolveTurnCodebaseContext(inst, { turnMode: 'bogus' });
  assert.equal(unknown.turnMode, null);
  assert.equal(unknown.workspaceProjectId, 'proj_p');

  // generic with no primary stays null (unchanged)
  assert.equal(
    resolveTurnCodebaseContext({ instanceId: 'oi_y' }, { turnMode: 'generic' }).workspaceProjectId,
    null,
  );
});

test('A2a: POST /conversations/:id/message forwards codebaseProjectId + turnMode', async () => {
  const calls = [];
  const spyConversationService = {
    sendMessage: async (id, opts) => { calls.push({ id, opts }); return { ok: true }; },
  };
  const app = express();
  app.use(express.json());
  app.use('/api/conversations', createConversationsRouter({
    conversationService: spyConversationService,
    runService: {},
  }));

  await request(app)
    .post('/api/conversations/operator:proj_1/message')
    .send({ text: 'hi', codebaseProjectId: 'proj_2', turnMode: 'codebase' })
    .expect(200);

  assert.equal(calls.length, 1);
  assert.equal(calls[0].id, 'operator:proj_1');
  assert.equal(calls[0].opts.text, 'hi');
  assert.equal(calls[0].opts.codebaseProjectId, 'proj_2');
  assert.equal(calls[0].opts.turnMode, 'codebase');
});

test('A2a: message route omitting the new fields passes them as undefined (legacy default)', async () => {
  const calls = [];
  const spyConversationService = {
    sendMessage: async (id, opts) => { calls.push({ id, opts }); return { ok: true }; },
  };
  const app = express();
  app.use(express.json());
  app.use('/api/conversations', createConversationsRouter({
    conversationService: spyConversationService,
    runService: {},
  }));

  await request(app)
    .post('/api/conversations/operator:proj_1/message')
    .send({ text: 'hi' })
    .expect(200);

  assert.equal(calls[0].opts.codebaseProjectId, undefined);
  assert.equal(calls[0].opts.turnMode, undefined);
});
