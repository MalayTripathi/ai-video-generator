import { defineConfig, devices } from '@playwright/test'

export default defineConfig({
  testDir: './tests',
  fullyParallel: true,
  reporter: 'list',
  globalSetup: './tests/global-setup.ts',
  globalTeardown: './tests/global-teardown.ts',
  use: {
    baseURL: 'http://localhost:3000',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    // Default browser identity for every spec: the primary fixed user global-setup.ts
    // authenticates once per run. A spec needing the secondary identity's browser
    // context opts in with test.use({ storageState: SECONDARY_STORAGE_STATE }) from
    // tests/fixed-users.ts; a spec needing a genuinely fresh user still calls
    // createTestSession() directly (see CLAUDE.md's Testing section).
    storageState: './tests/.auth/primary.storageState.json',
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