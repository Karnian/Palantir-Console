const { test, expect, request } = require('@playwright/test');

// PostK-e2e-migrate (2026-04-27): hash-route smoke checks switched to
// `[data-view="<route>"]` selectors so K-low copy revisions don't
// regress this file. Each route wrapper exposes a single data-view
// attribute corresponding to its hash key in app/lib/nav.js.

test.describe('Palantir Console Smoke', () => {
  test('dashboard loads with title and nav sidebar', async ({ page }) => {
    await page.goto('/');
    await expect(page).toHaveTitle(/Palantir/i);
    // NavSidebar renders as <nav class="nav-sidebar">
    await expect(page.locator('nav.nav-sidebar')).toBeVisible();
  });

  test('nav sidebar contains all route items', async ({ page }) => {
    await page.goto('/');
    const nav = page.locator('nav.nav-sidebar');
    // NAV_ITEMS: Dashboard, Manager, Task Board, Projects,
    // Resources, Memory, Operator (agents 는 nav 에서 숨김 — 라우트는 유지,
    // nodes-ui-polish 2026-07-05)
    await expect(nav.locator('.nav-item')).toHaveCount(7);
  });

  test('hash navigation to #mcp-servers renders the MCP route', async ({ page }) => {
    await page.goto('/#mcp-servers');
    await expect(page.locator('[data-view="mcp-servers"]')).toBeVisible();
    // Seeded templates from skillPackService.DEFAULT_MCP_TEMPLATES should
    // render somewhere in the route. We assert at least one default
    // alias is present so the route resolves to McpTemplatesView (not a
    // fallback Dashboard).
    await expect(page.locator('body')).toContainText(/playwright|filesystem/);
  });

  test('hash navigation to #dashboard renders the dashboard route', async ({ page }) => {
    await page.goto('/#dashboard');
    await expect(page.locator('[data-view="dashboard"]')).toBeVisible();
    await expect(page.locator('nav.nav-sidebar .nav-item.active')).toBeVisible();
  });

  test('hash navigation to #manager renders the manager route', async ({ page }) => {
    await page.goto('/#manager');
    await expect(page.locator('[data-view="manager"]')).toBeVisible();
  });

  test('hash navigation to #projects renders the projects route', async ({ page }) => {
    await page.goto('/#projects');
    await expect(page.locator('[data-view="projects"]')).toBeVisible();
  });

  test('hash navigation to #agents renders the agents route', async ({ page }) => {
    await page.goto('/#agents');
    await expect(page.locator('[data-view="agents"]')).toBeVisible();
  });

  test('hash navigation to #board renders the board route', async ({ page }) => {
    await page.goto('/#board');
    await expect(page.locator('[data-view="board"]')).toBeVisible();
  });

  test('hash navigation to #presets renders the presets route', async ({ page }) => {
    await page.goto('/#presets');
    await expect(page.locator('[data-view="presets"]')).toBeVisible();
  });

  test('hash navigation to #skills renders the skills route', async ({ page }) => {
    await page.goto('/#skills');
    await expect(page.locator('[data-view="skills"]')).toBeVisible();
  });
});

test.describe('Project CRUD API', () => {
  const BASE = 'http://localhost:4177';

  test('create → get → update → delete project', async ({ request }) => {
    // Create
    const createRes = await request.post(`${BASE}/api/projects`, {
      data: { name: 'E2E Test Project', directory: '/tmp/e2e-proj', description: 'Created by E2E' },
    });
    expect(createRes.status()).toBe(201);
    const { project } = await createRes.json();
    expect(project).toMatchObject({ name: 'E2E Test Project', description: 'Created by E2E' });
    const projectId = project.id;

    // Get
    const getRes = await request.get(`${BASE}/api/projects/${projectId}`);
    expect(getRes.status()).toBe(200);
    const { project: fetched } = await getRes.json();
    expect(fetched.id).toBe(projectId);
    expect(fetched.name).toBe('E2E Test Project');

    // Update
    const patchRes = await request.patch(`${BASE}/api/projects/${projectId}`, {
      data: { name: 'E2E Test Project (updated)', description: 'Updated by E2E' },
    });
    expect(patchRes.status()).toBe(200);
    const { project: updated } = await patchRes.json();
    expect(updated.name).toBe('E2E Test Project (updated)');

    // List — project should appear
    const listRes = await request.get(`${BASE}/api/projects`);
    expect(listRes.status()).toBe(200);
    const { projects } = await listRes.json();
    const found = projects.find(p => p.id === projectId);
    expect(found).toBeTruthy();

    // Delete
    const delRes = await request.delete(`${BASE}/api/projects/${projectId}`);
    expect(delRes.status()).toBe(200);

    // Get after delete — should 404
    const afterDelRes = await request.get(`${BASE}/api/projects/${projectId}`);
    expect(afterDelRes.status()).toBe(404);
  });
});

test.describe('Agent Profile API', () => {
  const BASE = 'http://localhost:4177';

  test('create → get agent profile', async ({ request }) => {
    // Create
    const createRes = await request.post(`${BASE}/api/agents`, {
      data: { name: 'E2E Agent', type: 'claude-code', command: 'claude', icon: '🤖', color: '#ff0000' },
    });
    expect(createRes.status()).toBe(201);
    const { agent } = await createRes.json();
    expect(agent).toMatchObject({ name: 'E2E Agent', type: 'claude-code' });
    const agentId = agent.id;

    // Get
    const getRes = await request.get(`${BASE}/api/agents/${agentId}`);
    expect(getRes.status()).toBe(200);
    const { agent: fetched } = await getRes.json();
    expect(fetched.id).toBe(agentId);
    expect(fetched.name).toBe('E2E Agent');

    // List — agent should appear
    const listRes = await request.get(`${BASE}/api/agents`);
    expect(listRes.status()).toBe(200);
    const { agents } = await listRes.json();
    const found = agents.find(a => a.id === agentId);
    expect(found).toBeTruthy();

    // Cleanup
    await request.delete(`${BASE}/api/agents/${agentId}`);
  });
});
