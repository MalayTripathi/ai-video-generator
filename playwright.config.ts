import { defineConfig, devices } from '@playwright/test'

export default defineConfig({
  testDir: './tests',
  fullyParallel: true,
  reporter: 'list',
  globalSetup: './tests/global-setup.ts',
  use: {
    baseURL: 'http://localhost:3000',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'chrome',
      use: { ...devices['Desktop Chrome'], channel: 'chrome' },
    },
  ],
  webServer: {
    command: 'npm run dev',
    url: 'http://localhost:3000',
    reuseExistingServer: true,
    // Playwright spawns this as a child process that would otherwise inherit an
    // already-exported shell value. Force it closed regardless - there is no sanctioned
    // way to make a live Anthropic call through the dev server this suite drives.
    env: { ALLOW_REAL_CLAUDE: '' },
  },
})