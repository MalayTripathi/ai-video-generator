import { defineConfig, devices } from '@playwright/test'
import { API_SPECS, UI_SPECS } from './tests/spec-layers'

// Every automated run blocks real provider calls (src/lib/providers/live-call-guard.ts),
// in this runner, its workers, and the server below. global-setup.ts refuses to start
// without it.
process.env.BLOCK_PROVIDER_CALLS = '1'

// Exact filename match for each layer's specs (tests/spec-layers.ts).
function specFiles(names: readonly string[]): RegExp {
  return new RegExp(`[\\/](${names.map((name) => name.replace(/\./g, '\\.')).join('|')})$`)
}

// Sized for a 2-core machine: every worker shares one single-process Next server and the
// CPU with each ui worker's Chrome. More workers than this oversubscribe it - server
// actions then answer after the tests' waits expire. Measured, not guessed: ui 3 is no
// faster end to end and fails on slow saves; api 8 only adds load. Override per run with
// PW_UI_WORKERS / PW_API_WORKERS on a bigger machine.
const UI_WORKERS = Number(process.env.PW_UI_WORKERS ?? 2)
const API_WORKERS = Number(process.env.PW_API_WORKERS ?? 4)

// PW_SERVER=prod (the full run) serves a production build; anything else is the dev
// server, for targeted runs mid-task. A production run never reuses a server it did not
// start: a stray dev server on :3000 would otherwise be tested, unguarded, in its place.
const PROD_SERVER = process.env.PW_SERVER === 'prod'

export default defineConfig({
  testDir: './tests',
  fullyParallel: true,
  workers: UI_WORKERS + API_WORKERS,
  // Full runs and their resumptions (test:full, test:failed) each add one blob to
  // blob-report/; test:report merges every blob there into one HTML report. An explicit
  // outputFile keeps the blob reporter from clearing the folder, so a resumed run adds to
  // the first run's report rather than replacing it. Targeted runs just print.
  reporter: PROD_SERVER
    ? [['line'], ['blob', { outputFile: `blob-report/run-${new Date().toISOString().replace(/[:.]/g, '-')}.zip` }]]
    : 'list',
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
      name: 'ui',
      testMatch: specFiles(UI_SPECS),
      workers: UI_WORKERS,
      use: { ...devices['Desktop Chrome'], channel: 'chrome' },
    },
    {
      // Never launches a browser: its specs use the request fixture, direct imports and
      // Supabase clients only (enforced by tests/spec-layers.spec.ts).
      name: 'api',
      testMatch: specFiles(API_SPECS),
      workers: API_WORKERS,
    },
  ],
  webServer: {
    command: PROD_SERVER ? 'npm run build && npm run start' : 'npm run dev',
    url: 'http://localhost:3000',
    reuseExistingServer: !PROD_SERVER,
    timeout: PROD_SERVER ? 600_000 : 60_000,
    // Playwright spawns this as a child process that would otherwise inherit an
    // already-exported shell value. Force the opt-outs closed and the block on regardless -
    // there is no sanctioned way to make a live provider call through the server this
    // suite drives.
    env: {
      BLOCK_PROVIDER_CALLS: '1',
      ALLOW_REAL_CLAUDE: '',
      ALLOW_REAL_OPENAI_IMAGES: '',
      ALLOW_REAL_ELEVENLABS: '',
    },
  },
})