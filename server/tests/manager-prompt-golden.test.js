'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { buildManagerSystemPrompt } = require('../services/managerSystemPrompt');
const { createCodexAdapter } = require('../services/managerAdapters/codexAdapter');
const { createClaudeAdapter } = require('../services/managerAdapters/claudeAdapter');

const FIXTURE_DIR = path.join(__dirname, 'fixtures');
const UPDATE_GOLDEN = process.env.UPDATE_MANAGER_PROMPT_GOLDEN === '1';
const FIXED_INPUT = Object.freeze({
  port: 4317,
  apiBaseUrl: 'http://manager.golden.test:4317',
});

// The prompt embeds `adapter.buildGuardrailsSection({ layer })`. Passing a null
// adapter drops that section from every fixture, so the golden would stop
// covering the vendor guardrail text entirely. Build the real adapters — their
// guardrail builders are pure — so the captured bytes include it.
const noopEngine = {
  spawnAgent: () => ({ pid: 1 }),
  isAlive: () => false,
  detectExitCode: () => null,
  kill: () => true,
  getOutput: () => '',
  getUsage: () => null,
  getSessionId: () => null,
  sendInput: () => true,
};

function adapterFor(name) {
  if (name === 'codex') return createCodexAdapter({ runService: null });
  if (name === 'claude-code') {
    return createClaudeAdapter({ streamJsonEngine: noopEngine, runService: null });
  }
  return null; // fallback: no adapter wired — guardrails omitted by design
}

const matrix = [];
for (const layer of ['top', 'operator']) {
  for (const adapter of [
    { name: 'codex', value: 'codex' },
    { name: 'claude-code', value: 'claude-code' },
    { name: 'fallback', value: null },
  ]) {
    for (const token of [
      { name: 'token-absent', value: null },
      { name: 'token-present', value: 'fixed-manager-capability' },
    ]) {
      for (const specialistAvailable of [false, true]) {
        matrix.push({ layer, adapter, token, specialistAvailable });
      }
    }
  }
}

test('manager system prompt matches byte-for-byte golden fixtures', async (t) => {
  for (const entry of matrix) {
    const specialist = entry.specialistAvailable
      ? 'specialist-available'
      : 'specialist-unavailable';
    const fixtureName = [
      'manager-prompt',
      entry.layer,
      entry.adapter.name,
      entry.token.name,
      specialist,
    ].join('__') + '.txt';
    const fixturePath = path.join(FIXTURE_DIR, fixtureName);
    const buildArgs = () => ({
      ...FIXED_INPUT,
      adapter: adapterFor(entry.adapter.name),
      layer: entry.layer,
      adapterType: entry.adapter.value,
      token: entry.token.value,
      specialistAvailable: entry.specialistAvailable,
    });

    await t.test(fixtureName, () => {
      const first = buildManagerSystemPrompt(buildArgs());
      const second = buildManagerSystemPrompt(buildArgs());
      assert.equal(second, first, 'the prompt builder must be deterministic');

      if (UPDATE_GOLDEN) fs.writeFileSync(fixturePath, first, 'utf8');
      const golden = fs.readFileSync(fixturePath, 'utf8');
      assert.equal(first, golden);
    });
  }
});

// Guards the wiring above. If someone reverts the adapter to null the vendor
// guardrail text silently leaves the prompt, and regenerated fixtures would
// happily agree with each other while covering nothing.
test('golden fixtures capture the vendor guardrail sections', () => {
  const codex = buildManagerSystemPrompt({
    ...FIXED_INPUT,
    adapter: adapterFor('codex'),
    layer: 'operator',
    adapterType: 'codex',
    token: null,
  });
  assert.match(codex, /Codex CLI adapter notes/);

  const claude = buildManagerSystemPrompt({
    ...FIXED_INPUT,
    adapter: adapterFor('claude-code'),
    layer: 'operator',
    adapterType: 'claude-code',
    token: null,
  });
  assert.match(claude, /Claude Code adapter notes/);
});
