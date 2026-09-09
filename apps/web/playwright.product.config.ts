import { defineConfig, devices } from '@playwright/test'

export default defineConfig({
  testDir: '../../tests/e2e',
  outputDir: '../../test-results/playwright-product',
  reporter: [['list']],
  use: { baseURL: 'http://127.0.0.1:4327', screenshot: 'only-on-failure', trace: 'retain-on-failure' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: '..\\..\\node_modules\\.bin\\tsx.cmd ..\\..\\tests\\e2e\\mock-server.ts',
    url: 'http://127.0.0.1:4327/api/v1/health',
    reuseExistingServer: false,
    timeout: 30_000,
  },
})
