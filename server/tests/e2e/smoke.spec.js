const { test, expect, request } = require('@playwright/test');

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
    // NAV_ITEMS: Dashboard, Manager, Task Board, Projects, Agents
    await expect(nav.locator('.nav-item')).toHaveCount(5);
  });

  test('hash navigation to #dashboard', async ({ page }) => {
    await page.goto('/#dashboard');
    // Dashboard view should render task/run-related content
    await expect(page.locator('#app')).not.toBeEmpty();
    await expect(page.locator('nav.nav-sidebar .nav-item.active')).toBeVisible();
  });

  test('hash navigation to #manager', async ({ page }) => {
    await page.goto('/#manager');
    await expect(page.locator('#app')).not.toBeEmpty();
    // Manager page renders agent/session related UI
    await expect(page.locator('body')).toContainText(/manager|session|agent/i);
  });

  test('hash navigation to #projects', async ({ page }) => {
    await page.goto('/#projects');
    await expect(page.locator('#app')).not.toBeEmpty();
    await expect(page.locator('body')).toContainText(/project/i);
  });

  test('hash navigation to #agents', async ({ page }) => {
    await page.goto('/#agents');
    await expect(page.locator('#app')).not.toBeEmpty();
    await expect(page.locator('body')).toContainText(/agent/i);
  });

  test('hash navigation to #board', async ({ page }) => {
    await page.goto('/#board');
    await expect(page.locator('#app')).not.toBeEmpty();
    // Task Board page
    await expect(page.locator('body')).toContainText(/task|board/i);
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
