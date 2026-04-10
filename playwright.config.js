const { defineConfig } = require('@playwright/test');

module.exports = defineConfig({
  testDir: './server/tests/e2e',
  timeout: 30000,
  use: {
    baseURL: 'http://localhost:4177',
  },
  webServer: {
    command: 'npm start',
    port: 4177,
    reuseExistingServer: !process.env.CI,
    timeout: 30000,
  },
});
