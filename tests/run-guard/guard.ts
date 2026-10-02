// Full-run guard: the single place the full-run threshold and the per-module cap live.
// playwright.config.ts counts the tests a run would execute (by running Playwright's own
// --list mode in a child process, before global setup or any Supabase contact) and asks
// evaluateRun() whether that run may start. Every authorised full run is recorded in
// tests/full-run-ledger.json - written when the guard passes, finished by
// ledger-reporter.ts - so a run killed half-way still counts against its module's cap.
//
// Imports node builtins only, and uses erasable TS syntax only, so guard.test.mjs can load
// it through Node's native type stripping, outside the Playwright runner (anything run
// through the runner triggers global setup, which contacts Supabase).
import { readFileSync, writeFileSync } from 'node:fs'

export const RUN_GUARD = {
  // A run of more than this many tests is a full run, however it is launched.
  FULL_RUN_THRESHOLD: 150,
  // Full runs per module: one at module close, one confirming run after fixes are approved.
  RUNS_PER_MODULE: 2,
  // Extra runs PW_FULL_RUN_OVERRIDE=1 allows past the cap, each logged as an override.
  OVERRIDE_EXTRA_RUNS: 1,
} as const

export const RUN_GUARD_ENV = {
  MODULE: 'PW_FULL_RUN_MODULE',
  OVERRIDE: 'PW_FULL_RUN_OVERRIDE',
  DRY_RUN: 'PW_RUN_GUARD_DRY_RUN',
  // Set by the test:full script only: that script needs a module whatever the count.
  FULL_SCRIPT: 'PW_FULL_RUN_SCRIPT',
  // Set on the --list child the guard spawns, so that child does not guard itself.
  CHILD: 'PW_RUN_GUARD_CHILD',
} as const

export const COUNT_MARKER = 'RUN_GUARD_COUNT='

export type LedgerEntry = {
  id: string
  module: string
  startedAt: string
  finishedAt: string | null
  tests: number
  durationMs: number | null
  passed: number | null
  failed: number | null
  flaky: number | null
  skipped: number | null
  status: 'started' | 'passed' | 'failed' | 'interrupted' | 'timedout'
  override: boolean
}

export type RunResults = Pick<
  LedgerEntry,
  'finishedAt' | 'durationMs' | 'passed' | 'failed' | 'flaky' | 'skipped' | 'status'
>

export type RunDecision =
  | { kind: 'unguarded' }
  | { kind: 'authorised'; module: string; runNumber: number; override: boolean }
  | { kind: 'refused'; message: string }

export function countFromListOutput(stdout: string): number {
  const line = stdout.split('\n').find((l) => l.startsWith(COUNT_MARKER))
  const count = line ? Number(line.slice(COUNT_MARKER.length).trim()) : NaN
  if (!Number.isInteger(count) || count < 0) {
    throw new Error(`run guard: could not read a test count from the --list child's output`)
  }
  return count
}

export function evaluateRun(input: {
  count: number
  module: string | undefined
  override: boolean
  viaFullScript: boolean
  ledger: readonly LedgerEntry[]
  validModules: readonly string[]
}): RunDecision {
  const { count, override, viaFullScript, ledger, validModules } = input
  const moduleName = input.module?.trim() || undefined
  const threshold = RUN_GUARD.FULL_RUN_THRESHOLD
  const cap = RUN_GUARD.RUNS_PER_MODULE
  const hardCap = cap + RUN_GUARD.OVERRIDE_EXTRA_RUNS
  const head = `run guard: this run would execute ${count} tests (full-run threshold: ${threshold}).`
  const how =
    `A full run needs ${RUN_GUARD_ENV.MODULE}=<module>, where <module> is one Step build ` +
    `(${validModules.join(', ')}), e.g. ${RUN_GUARD_ENV.MODULE}=storyboard npm run test:full. ` +
    `Each module gets ${cap} full runs, recorded in tests/full-run-ledger.json; ` +
    `${RUN_GUARD_ENV.OVERRIDE}=1 allows ${RUN_GUARD.OVERRIDE_EXTRA_RUNS} more, logged as an override. ` +
    `Run targeted specs or @smoke instead to stay under the threshold.`

  if (!moduleName) {
    if (viaFullScript) {
      return { kind: 'refused', message: `${head}\nnpm run test:full requires ${RUN_GUARD_ENV.MODULE}.\n${how}` }
    }
    if (count > threshold) {
      return { kind: 'refused', message: `${head}\nRefused: no module is authorised.\n${how}` }
    }
    return { kind: 'unguarded' }
  }

  if (!validModules.includes(moduleName)) {
    return { kind: 'refused', message: `${head}\nRefused: "${moduleName}" is not a module.\n${how}` }
  }

  const used = ledger.filter((entry) => entry.module === moduleName).length
  if (used >= hardCap) {
    return {
      kind: 'refused',
      message: `${head}\nRefused: module "${moduleName}" has used ${used} of ${cap} full runs plus its override; none remain.\n${how}`,
    }
  }
  if (used >= cap && !override) {
    return {
      kind: 'refused',
      message: `${head}\nRefused: module "${moduleName}" has used ${used} of ${cap} full runs (0 remaining).\n${how}`,
    }
  }
  return { kind: 'authorised', module: moduleName, runNumber: used + 1, override: used >= cap }
}

// Fails closed: a missing ledger is empty, but an unreadable one throws rather than
// silently resetting every module's count to zero.
export function readLedger(file: string): LedgerEntry[] {
  let raw: string
  try {
    raw = readFileSync(file, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
  const parsed: unknown = JSON.parse(raw)
  if (!Array.isArray(parsed)) throw new Error(`run guard: ${file} is not a JSON array`)
  return parsed as LedgerEntry[]
}

function writeLedger(file: string, entries: readonly LedgerEntry[]): void {
  writeFileSync(file, JSON.stringify(entries, null, 2) + '\n')
}

export function appendStarted(
  file: string,
  run: { module: string; tests: number; override: boolean; startedAt: string },
): LedgerEntry {
  const entry: LedgerEntry = {
    id: run.startedAt,
    module: run.module,
    startedAt: run.startedAt,
    finishedAt: null,
    tests: run.tests,
    durationMs: null,
    passed: null,
    failed: null,
    flaky: null,
    skipped: null,
    status: 'started',
    override: run.override,
  }
  writeLedger(file, [...readLedger(file), entry])
  return entry
}

export function finalizeEntry(file: string, id: string, results: RunResults): void {
  const entries = readLedger(file)
  const index = entries.findIndex((entry) => entry.id === id)
  if (index === -1) throw new Error(`run guard: no ledger entry ${id} in ${file}`)
  entries[index] = { ...entries[index], ...results }
  writeLedger(file, entries)
}
