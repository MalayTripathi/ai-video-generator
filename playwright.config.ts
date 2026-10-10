import { execFileSync } from 'node:child_process'
import { rmSync } from 'node:fs'
import path from 'node:path'
import { defineConfig, devices, type ReporterDescription } from '@playwright/test'
import { STEPS } from './src/lib/config/pipeline'
import { API_SPECS, UI_SPECS } from './tests/spec-layers'
import { appendStarted, countFromListOutput, evaluateRun, readLedger, RUN_GUARD_ENV } from './tests/run-guard/guard'
import './tests/helpers/server-only-preload.cjs'

// Every automated run blocks real provider calls (src/lib/providers/live-call-guard.ts),
// in this runner, its workers, and the server below. global-setup.ts refuses to start
// without it.
process.env.BLOCK_PROVIDER_CALLS = '1'

// `server-only` resolves to its empty module in this runner (the preload import above) and in every
// worker it forks (NODE_OPTIONS, inherited) - see the preload file. The web server is given
// the original NODE_OPTIONS back, so Next resolves `server-only` exactly as it ships.
const SERVER_ONLY_PRELOAD = path.resolve(__dirname, 'tests/helpers/server-only-preload.cjs')
const ORIGINAL_NODE_OPTIONS = process.env.NODE_OPTIONS ?? ''
if (!ORIGINAL_NODE_OPTIONS.includes(SERVER_ONLY_PRELOAD)) {
  process.env.NODE_OPTIONS = `${ORIGINAL_NODE_OPTIONS} --require ${JSON.stringify(SERVER_ONLY_PRELOAD)}`.trim()
}

// PW_SERVER=prod (the full run) serves a production build; anything else is the dev
// server, for targeted runs mid-task. A production run never reuses a server it did not
// start: a stray dev server on :3000 would otherwise be tested, unguarded, in its place.
const PROD_SERVER = process.env.PW_SERVER === 'prod'

const LEDGER_PATH = path.resolve(__dirname, 'tests/full-run-ledger.json')

// Full-run guard (tests/run-guard/guard.ts). A run's tests load only after the web server
// and global setup have started, so this config - the one thing evaluated earlier - counts
// them itself: it runs this same command in Playwright's --list mode (which runs no global
// setup and starts no server) and refuses a run over the threshold that no module
// authorises. Evaluated once, in the runner process of a `test` command only: never in a
// worker, the --list child, or a run that is itself only listing.
function guardRun(): ReporterDescription[] {
  const args = process.argv.slice(2)
  const marker = Symbol.for('reelcraft.runGuard')
  const state = globalThis as typeof globalThis & { [marker]?: ReporterDescription[] }
  if (state[marker]) return state[marker]
  if (
    args[0] !== 'test' ||
    args.includes('--list') ||
    process.env.TEST_WORKER_INDEX !== undefined ||
    process.env[RUN_GUARD_ENV.CHILD] === '1'
  ) {
    return []
  }

  // UI mode can run anything it lists, so count what it would list.
  const listArgs = args.filter((arg, i) => {
    if (arg === '--ui' || arg.startsWith('--ui-host=') || arg.startsWith('--ui-port=')) return false
    if ((arg === '--ui-host' || arg === '--ui-port') && args[i + 1]) return false
    if (i > 0 && (args[i - 1] === '--ui-host' || args[i - 1] === '--ui-port')) return false
    return true
  })
  const stdout = execFileSync(
    process.execPath,
    [process.argv[1], ...listArgs, '--list', '--reporter', path.resolve(__dirname, 'tests/run-guard/count-reporter.ts')],
    { env: { ...process.env, [RUN_GUARD_ENV.CHILD]: '1' }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] },
  )
  const count = countFromListOutput(stdout)
  const decision = evaluateRun({
    count,
    module: process.env[RUN_GUARD_ENV.MODULE],
    override: process.env[RUN_GUARD_ENV.OVERRIDE] === '1',
    viaFullScript: process.env[RUN_GUARD_ENV.FULL_SCRIPT] === '1',
    ledger: readLedger(LEDGER_PATH),
    validModules: STEPS,
  })

  if (decision.kind === 'refused') {
    console.error(`\n${decision.message}\n`)
    process.exit(1)
  }
  if (process.env[RUN_GUARD_ENV.DRY_RUN] === '1') {
    const what =
      decision.kind === 'authorised'
        ? `authorised full run ${decision.runNumber} for module "${decision.module}"${decision.override ? ' (override)' : ''}`
        : 'under the full-run threshold'
    console.log(`run guard: passed (dry run) - ${count} tests, ${what}; stopping before global setup`)
    process.exit(0)
  }

  let reporters: ReporterDescription[] = []
  if (decision.kind === 'authorised') {
    const entry = appendStarted(LEDGER_PATH, {
      module: decision.module,
      tests: count,
      override: decision.override,
      startedAt: new Date().toISOString(),
    })
    console.log(
      `run guard: full run ${decision.runNumber} for module "${decision.module}" (${count} tests)` +
        `${decision.override ? ', override' : ''} - recorded in tests/full-run-ledger.json`,
    )
    reporters = [['./tests/run-guard/ledger-reporter.ts', { ledgerPath: LEDGER_PATH, entryId: entry.id }]]
    // A full run starts a fresh merged report (test:report); its resumptions add to it.
    if (PROD_SERVER) rmSync(path.resolve(__dirname, 'blob-report'), { recursive: true, force: true })
  }
  state[marker] = reporters
  return reporters
}

const guardReporters = guardRun()

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

export default defineConfig({
  testDir: './tests',
  fullyParallel: true,
  workers: UI_WORKERS + API_WORKERS,
  // Full runs and their resumptions (test:full, test:failed) each add one blob to
  // blob-report/; test:report merges every blob there into one HTML report. An explicit
  // outputFile keeps the blob reporter from clearing the folder, so a resumed run adds to
  // the first run's report rather than replacing it. Targeted runs just print.
  reporter: [
    ...(PROD_SERVER
      ? ([['line'], ['blob', { outputFile: `blob-report/run-${new Date().toISOString().replace(/[:.]/g, '-')}.zip` }]] as ReporterDescription[])
      : ([['list']] as ReporterDescription[])),
    ...guardReporters,
  ],
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
      NODE_OPTIONS: ORIGINAL_NODE_OPTIONS.replace(`--require ${JSON.stringify(SERVER_ONLY_PRELOAD)}`, '').trim(),
      BLOCK_PROVIDER_CALLS: '1',
      ALLOW_REAL_CLAUDE: '',
      ALLOW_REAL_OPENAI_IMAGES: '',
      ALLOW_REAL_ELEVENLABS: '',
    },
  },
})