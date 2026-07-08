'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const {
  parseProjectConversationId,
  resolveOperatorConversationId,
  createOperatorConversationIdResolver,
  isInstanceConversationId,
} = require('../utils/conversationId');

test('resolveOperatorConversationId resolves instance form without legacy canonical output', () => {
  const resolved = resolveOperatorConversationId('operator:oi_alpha');

  assert.deepEqual(resolved, {
    instanceId: 'oi_alpha',
    legacyProjectId: null,
    legacySlotId: null,
    instanceConversationId: 'operator:oi_alpha',
    primaryProjectId: null,
  });
  assert.equal(Object.hasOwn(resolved, 'canonical'), false);
});

test('resolveOperatorConversationId resolves instance form with primary project lookup', () => {
  const resolved = resolveOperatorConversationId('operator:oi_alpha', {
    lookupInstanceById(instanceId) {
      assert.equal(instanceId, 'oi_alpha');
      return { instanceId, primaryProjectId: 'alpha' };
    },
  });

  assert.deepEqual(resolved, {
    instanceId: 'oi_alpha',
    legacyProjectId: null,
    legacySlotId: 'operator:alpha',
    instanceConversationId: 'operator:oi_alpha',
    primaryProjectId: 'alpha',
  });
});

test('resolveOperatorConversationId resolves legacy project form and optional instance lookup', () => {
  assert.deepEqual(resolveOperatorConversationId('operator:alpha'), {
    instanceId: null,
    legacyProjectId: 'alpha',
    legacySlotId: 'operator:alpha',
    instanceConversationId: null,
    primaryProjectId: null,
  });

  const resolved = resolveOperatorConversationId('operator:alpha', {
    lookupInstanceByProject(projectId) {
      assert.equal(projectId, 'alpha');
      return { instanceId: 'oi_alpha', primaryProjectId: 'alpha' };
    },
  });

  assert.deepEqual(resolved, {
    instanceId: 'oi_alpha',
    legacyProjectId: 'alpha',
    legacySlotId: 'operator:alpha',
    instanceConversationId: 'operator:oi_alpha',
    primaryProjectId: 'alpha',
  });
});

test('parseProjectConversationId rejects instance-looking operator ids and malformed ids', () => {
  assert.equal(parseProjectConversationId('operator:oi_alpha'), null);
  assert.equal(parseProjectConversationId('operator:oi_'), null);
  assert.deepEqual(parseProjectConversationId('operator:alpha'), { projectId: 'alpha' });
  assert.equal(parseProjectConversationId('top'), null);
  assert.equal(parseProjectConversationId('worker:r1'), null);
  assert.equal(parseProjectConversationId(''), null);
  assert.equal(parseProjectConversationId(null), null);
  assert.equal(parseProjectConversationId(42), null);
});

test('resolveOperatorConversationId is safe for non-operator and malformed ids', () => {
  assert.equal(resolveOperatorConversationId('top'), null);
  assert.equal(resolveOperatorConversationId('worker:r1'), null);
  assert.equal(resolveOperatorConversationId('operator:'), null);
  assert.equal(resolveOperatorConversationId('operator:oi_'), null);
  assert.equal(resolveOperatorConversationId(''), null);
  assert.equal(resolveOperatorConversationId(null), null);
  assert.equal(resolveOperatorConversationId(42), null);
});

test('createOperatorConversationIdResolver wires primary lookups through better-sqlite3 statements', (t) => {
  const db = new Database(':memory:');
  t.after(() => db.close());
  db.exec(`
    CREATE TABLE operator_instances (
      id TEXT NOT NULL PRIMARY KEY
    );
    CREATE TABLE operator_codebase_refs (
      instance_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      role TEXT NOT NULL
    );
    INSERT INTO operator_instances (id) VALUES ('oi_alpha'), ('oi_reference_only');
    INSERT INTO operator_codebase_refs (instance_id, project_id, role)
    VALUES
      ('oi_alpha', 'alpha', 'primary'),
      ('oi_reference_only', 'beta', 'reference');
  `);

  const resolver = createOperatorConversationIdResolver(db);

  assert.deepEqual(resolver('operator:alpha'), {
    instanceId: 'oi_alpha',
    legacyProjectId: 'alpha',
    legacySlotId: 'operator:alpha',
    instanceConversationId: 'operator:oi_alpha',
    primaryProjectId: 'alpha',
  });
  assert.deepEqual(resolver('operator:oi_alpha'), {
    instanceId: 'oi_alpha',
    legacyProjectId: null,
    legacySlotId: 'operator:alpha',
    instanceConversationId: 'operator:oi_alpha',
    primaryProjectId: 'alpha',
  });
  assert.deepEqual(resolver('operator:beta'), {
    instanceId: null,
    legacyProjectId: 'beta',
    legacySlotId: 'operator:beta',
    instanceConversationId: null,
    primaryProjectId: null,
  });
});

test('isInstanceConversationId identifies only valid instance conversation ids', () => {
  assert.equal(isInstanceConversationId('operator:oi_alpha'), true);
  assert.equal(isInstanceConversationId('operator:oi_'), false);
  assert.equal(isInstanceConversationId('operator:alpha'), false);
  assert.equal(isInstanceConversationId('top'), false);
  assert.equal(isInstanceConversationId(null), false);
});

test('client conversation id helper rejects oi_ as project id and exposes instance predicate', async () => {
  const modUrl = pathToFileURL(
    path.join(__dirname, '..', 'public', 'app', 'lib', 'conversationId.js'),
  ).href;
  const client = await import(`${modUrl}?operator-resolver=${Date.now()}`);

  assert.equal(client.parseProjectConversationId('operator:oi_alpha'), null);
  assert.equal(client.parseProjectConversationId('operator:oi_'), null);
  assert.deepEqual(client.parseProjectConversationId('operator:alpha'), { projectId: 'alpha' });
  assert.equal(client.isInstanceConversationId('operator:oi_alpha'), true);
  assert.equal(client.isInstanceConversationId('operator:oi_'), false);
});
