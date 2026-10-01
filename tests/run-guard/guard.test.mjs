// Unit tests for the full-run guard. Run with `npm run test:guard` (node:test, Node's native
// TS type stripping) - deliberately outside Playwright, whose runner would start global
// setup and contact Supabase for a run of any size.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  appendStarted,
  COUNT_MARKER,
  countFromListOutput,
  evaluateRun,
  finalizeEntry,
  readLedger,
  RUN_GUARD,
} from './guard.ts'

const MODULES = ['workbench', 'image_prompts', 'storyboard', 'video_prompts', 'generation', 'assembly']
const OVER = RUN_GUARD.FULL_RUN_THRESHOLD + 1

function entries(module, n) {
  return Array.from({ length: n }, (_, i) => ({ id: `${module}-${i}`, module, status: 'passed' }))
}

function run(overrides = {}) {
  return evaluateRun({
    count: OVER,
    module: undefined,
    override: false,
    viaFullScript: false,
    ledger: [],
    validModules: MODULES,
    ...overrides,
  })
}

test('count parsing reads the marker line among other output', () => {
  assert.equal(countFromListOutput(`Listing tests:\n${COUNT_MARKER}1005\nTotal: 1005 tests\n`), 1005)
  assert.equal(countFromListOutput(`${COUNT_MARKER}0\n`), 0)
})

test('count parsing throws on a missing or garbled marker rather than guessing', () => {
  assert.throws(() => countFromListOutput('Total: 1005 tests in 95 files\n'))
  assert.throws(() => countFromListOutput(`${COUNT_MARKER}lots\n`))
  assert.throws(() => countFromListOutput(`${COUNT_MARKER}-3\n`))
})

test('threshold boundary: exactly the threshold is unguarded, one over is refused', () => {
  assert.deepEqual(run({ count: RUN_GUARD.FULL_RUN_THRESHOLD }), { kind: 'unguarded' })
  const refused = run({ count: OVER })
  assert.equal(refused.kind, 'refused')
  assert.match(refused.message, new RegExp(`${OVER} tests`))
  assert.match(refused.message, new RegExp(`threshold: ${RUN_GUARD.FULL_RUN_THRESHOLD}`))
  assert.match(refused.message, /PW_FULL_RUN_MODULE=/)
})

test('test:full without a module is refused even at a small count', () => {
  assert.equal(run({ count: 3, viaFullScript: true }).kind, 'refused')
  assert.equal(run({ count: 3, viaFullScript: true, module: '  ' }).kind, 'refused')
})

test('a module that is not a Step is refused', () => {
  const refused = run({ module: 'storybord' })
  assert.equal(refused.kind, 'refused')
  assert.match(refused.message, /"storybord" is not a module/)
})

test('runs 1 and 2 are authorised; 3 needs the override; 4 is refused regardless', () => {
  assert.deepEqual(run({ module: 'storyboard' }), { kind: 'authorised', module: 'storyboard', runNumber: 1, override: false })
  assert.deepEqual(run({ module: 'storyboard', ledger: entries('storyboard', 1) }), {
    kind: 'authorised', module: 'storyboard', runNumber: 2, override: false,
  })

  const third = run({ module: 'storyboard', ledger: entries('storyboard', 2) })
  assert.equal(third.kind, 'refused')
  assert.match(third.message, /used 2 of 2 full runs/)
  assert.deepEqual(run({ module: 'storyboard', ledger: entries('storyboard', 2), override: true }), {
    kind: 'authorised', module: 'storyboard', runNumber: 3, override: true,
  })

  const fourth = run({ module: 'storyboard', ledger: entries('storyboard', 3), override: true })
  assert.equal(fourth.kind, 'refused')
  assert.match(fourth.message, /none remain/)
})

test('the override does not mark a run within the cap as an override', () => {
  assert.deepEqual(run({ module: 'assembly', override: true }), {
    kind: 'authorised', module: 'assembly', runNumber: 1, override: false,
  })
})

test('runs are counted per module, whatever their status', () => {
  const ledger = [...entries('storyboard', 3), { id: 'x', module: 'assembly', status: 'started' }]
  assert.deepEqual(run({ module: 'assembly', ledger }), { kind: 'authorised', module: 'assembly', runNumber: 2, override: false })
})

test('an authorised module also covers a run under the threshold (test:full with a filter)', () => {
  assert.equal(run({ count: 10, module: 'storyboard', viaFullScript: true }).kind, 'authorised')
})

test('ledger: missing file reads as empty; append then finalize round-trips', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'run-guard-'))
  const file = path.join(dir, 'ledger.json')
  assert.deepEqual(readLedger(file), [])

  const entry = appendStarted(file, { module: 'storyboard', tests: 1005, override: false, startedAt: '2026-10-01T00:00:00.000Z' })
  assert.equal(entry.status, 'started')
  assert.deepEqual(readLedger(file), [entry])

  finalizeEntry(file, entry.id, {
    finishedAt: '2026-10-01T00:11:00.000Z', durationMs: 660000, passed: 1000, failed: 3, flaky: 2, skipped: 0, status: 'failed',
  })
  const [saved] = readLedger(file)
  assert.equal(saved.status, 'failed')
  assert.equal(saved.tests, 1005)
  assert.equal(saved.failed, 3)
  assert.equal(saved.durationMs, 660000)

  appendStarted(file, { module: 'storyboard', tests: 1005, override: false, startedAt: '2026-10-02T00:00:00.000Z' })
  assert.equal(readLedger(file).length, 2)
  assert.ok(readFileSync(file, 'utf8').endsWith('\n'))
  assert.throws(() => finalizeEntry(file, 'no-such-id', saved))
})

test('ledger: malformed JSON fails closed instead of resetting every count', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'run-guard-'))
  const file = path.join(dir, 'ledger.json')
  writeFileSync(file, '{ not json')
  assert.throws(() => readLedger(file))
  writeFileSync(file, '{"module":"storyboard"}')
  assert.throws(() => readLedger(file), /not a JSON array/)
})
