const { test: setup, expect } = require('@playwright/test');
const { TOKEN } = require('../../helpers/work-board-fixture.cjs');

setup('observe cookie login', async ({ request }) => {
  const response = await request.post('/api/auth/login', { data: { token: TOKEN } });
  expect(response.status()).toBe(200);
  const state = await request.storageState({ path: 'test-results/observe-auth.json' });
  expect(state.cookies.some(cookie => cookie.name === 'palantir_token')).toBe(true);
});
