const { defineConfig, devices } = require('@playwright/test');

// K-5 (2026-04-29): Visual regression runs against an isolated server
// instance bound to a fresh empty SQLite DB on a separate port (4189).
// Without this, baselines lock in whatever projects/tasks/runs the dev's
// local `palantir.db` happens to hold, and `--update-snapshots` would
// produce a different baseline on every checkout (Codex K-5 r1 BLOCK).
// Non-visual e2e (smoke / a11y / manager) keep the existing 4177 server
// because they only assert on data they create themselves.
// `npm run test:visual` sets this — visual.spec.js only ever hits :4189, so
// the :4177 webServer below is pure overhead for that command. Worse:
// `reuseExistingServer: false` on it (see comment below) means a dev's
// already-running :4177 makes `test:visual` abort trying to rebind the port,
// even though visual tests never touch it (Codex round-4 P2 catch).
const visualOnly = process.env.PALANTIR_VISUAL_ONLY === '1';

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
    ...(visualOnly ? [] : [{
      command: 'npm start',
      port: 4177,
      // Was `!process.env.CI` (reuse locally for a faster loop). Changed to
      // always false: reuse trusts "port answers = good" and never applies
      // the env override below, so a developer's already-running :4177 (e.g.
      // a manually started `npm start` that loaded PALANTIR_TOKEN from
      // .env) gets silently reused — auth-assuming-off smoke/manager specs
      // then fail with confusing 401s instead of a clear boot log. Safe to
      // do unconditionally now that visual-only runs skip this entry
      // entirely instead of fighting over the port (see `visualOnly` above).
      reuseExistingServer: false,
      timeout: 30000,
      // A developer's local .env (PALANTIR_TOKEN, non-default PORT, …) must
      // not leak into this server — tests assume no-auth on :4177.
      env: { PALANTIR_SKIP_DOTENV: '1' },
    }]),
    {
      // K-5 isolated webServer: every input that affects rendered HTML
      // is reset to a deterministic empty state before boot —
      //   * PALANTIR_DB → fresh /tmp DB (no projects/tasks/runs)
      //   * HOME        → empty tmp dir (no live `~/.claude/sessions`,
      //                   no `~/.codex/auth.json`, no opencode auth)
      //   * OPENCODE_STORAGE / CODEX_HOME → also tmp dirs so the
      //                   service constructors can't reach back into
      //                   real host state via fallback paths.
      //   * credential + feature env → cleared, see below.
      // reuseExistingServer must stay false — a stale 4189 from a prior
      // run could otherwise serve dirty data. (Codex K-5 r2 BLOCK fix.)
      //
      // #416: HOME/CODEX_HOME cover credentials that live on DISK, but the
      // resolvers also read them from the ENVIRONMENT, which this server
      // inherits. Those values reach the DOM — the manager route renders a
      // per-profile credential error, and #413's memory diagnostics panel
      // renders distiller status straight off ANTHROPIC_API_KEY. A developer
      // who exports a key would then diff against a baseline captured without
      // one. Clear them so a snapshot depends on the repo, not the shell.
      command: [
        // K-5 r3 BLOCK fix: rebuild better-sqlite3 first because we
        // bypass `npm start`'s `prestart` hook below. Without this a
        // fresh checkout (or one that flipped Node major) fails to
        // boot the visual server with a NODE_MODULE_VERSION mismatch.
        'npm rebuild better-sqlite3 --silent 2>/dev/null || true',
        'rm -rf /tmp/palantir-visual-db /tmp/palantir-visual-home /tmp/palantir-visual-opencode /tmp/palantir-visual-codex',
        'mkdir -p /tmp/palantir-visual-home /tmp/palantir-visual-opencode /tmp/palantir-visual-codex',
        // PALANTIR_SKIP_DOTENV — same leak this isolation block already
        // guards against, just for .env instead of ~/.claude etc.
        [
          'HOME=/tmp/palantir-visual-home',
          'OPENCODE_STORAGE=/tmp/palantir-visual-opencode',
          'CODEX_HOME=/tmp/palantir-visual-codex',
          'PALANTIR_DB=/tmp/palantir-visual-db',
          'PORT=4189',
          'PALANTIR_SKIP_DOTENV=1',
          // Bind explicitly — an inherited HOST can stop the server booting.
          'HOST=127.0.0.1',
          // Credentials the auth resolvers read from the environment.
          'ANTHROPIC_API_KEY=',
          'ANTHROPIC_BASE_URL=',
          'CLAUDE_CODE_OAUTH_TOKEN=',
          'CODEX_API_KEY=',
          'OPENAI_API_KEY=',
          // Clearing the env vars is not enough on its own: `.claude-auth.json`
          // lives at the REPO root (HOME cannot move it) and the macOS keychain
          // is not path-scoped, and an empty env value is precisely the falsy
          // condition that makes the resolver fall back to them. This switch
          // makes ambient host credential discovery inert.
          'PALANTIR_SKIP_HOST_CREDENTIALS=1',
          // Auth mode: a set token would bounce every route to /login.html.
          'PALANTIR_TOKEN=',
          // Feature flags whose state is surfaced in the UI.
          'PALANTIR_MEMORY_DISTILL=',
          'PALANTIR_OPERATOR_SPECIALIST=',
          'PALANTIR_WEBHOOK_URL=',
          // Rendered on #resources/models as the effective service tier.
          'PALANTIR_CODEX_FAST=',
          'node server/index.js',
        ].join(' '),
      ].join(' && '),
      port: 4189,
      reuseExistingServer: false,
      timeout: 30000,
    },
  ],
});
