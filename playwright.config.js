const { defineConfig, devices } = require('@playwright/test');

// K-5 (2026-04-29): Visual regression runs against an isolated server
// instance bound to a fresh empty SQLite DB on a separate port (4189).
// Without this, baselines lock in whatever projects/tasks/runs the dev's
// local `palantir.db` happens to hold, and `--update-snapshots` would
// produce a different baseline on every checkout (Codex K-5 r1 BLOCK).
// Non-visual e2e (smoke / a11y / manager) keep the existing 4177 server
// because they only assert on data they create themselves.
module.exports = defineConfig({
  testDir: './server/tests/e2e',
  timeout: 30000,
  use: {
    baseURL: 'http://localhost:4177',
    // K-5 (2026-04-29): disable CSS transitions/keyframes for visual
    // regression determinism. axe a11y is unaffected.
    reducedMotion: 'reduce',
  },
  // K-5 L12: pin to chromium so baseline PNGs are deterministic across
  // browsers Playwright might add later. Two projects:
  //   - chromium      → existing smoke / a11y / manager specs on :4177
  //   - visual-chromium → visual.spec.js only on :4189 (fresh empty DB)
  projects: [
    {
      name: 'chromium',
      testIgnore: '**/visual.spec.js',
      use: { ...devices['Desktop Chrome'] },
    },
    {
      name: 'visual-chromium',
      testMatch: '**/visual.spec.js',
      use: { ...devices['Desktop Chrome'], baseURL: 'http://localhost:4189' },
    },
  ],
  webServer: [
    {
      command: 'npm start',
      port: 4177,
      reuseExistingServer: !process.env.CI,
      timeout: 30000,
    },
    {
      // K-5 isolated webServer: every input that affects rendered HTML
      // is reset to a deterministic empty state before boot —
      //   * PALANTIR_DB → fresh /tmp DB (no projects/tasks/runs)
      //   * HOME        → empty tmp dir (no live `~/.claude/sessions`,
      //                   no `~/.codex/auth.json`, no opencode auth)
      //   * OPENCODE_STORAGE / CODEX_HOME → also tmp dirs so the
      //                   service constructors can't reach back into
      //                   real host state via fallback paths.
      // reuseExistingServer must stay false — a stale 4189 from a prior
      // run could otherwise serve dirty data. (Codex K-5 r2 BLOCK fix.)
      command: [
        // K-5 r3 BLOCK fix: rebuild better-sqlite3 first because we
        // bypass `npm start`'s `prestart` hook below. Without this a
        // fresh checkout (or one that flipped Node major) fails to
        // boot the visual server with a NODE_MODULE_VERSION mismatch.
        'npm rebuild better-sqlite3 --silent 2>/dev/null || true',
        'rm -rf /tmp/palantir-visual-db /tmp/palantir-visual-home /tmp/palantir-visual-opencode /tmp/palantir-visual-codex',
        'mkdir -p /tmp/palantir-visual-home /tmp/palantir-visual-opencode /tmp/palantir-visual-codex',
        'HOME=/tmp/palantir-visual-home OPENCODE_STORAGE=/tmp/palantir-visual-opencode CODEX_HOME=/tmp/palantir-visual-codex PALANTIR_DB=/tmp/palantir-visual-db PORT=4189 node server/index.js',
      ].join(' && '),
      port: 4189,
      reuseExistingServer: false,
      timeout: 30000,
    },
  ],
});
