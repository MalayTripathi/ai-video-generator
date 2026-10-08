import { test, expect } from '@playwright/test'
import { EXPORT_POLL_MS } from '../src/lib/config/export'
import { IDLE_BACKOFF_MAX_MS, nextIdleDelay, runWorkerLoop, STUCK_SWEEP_INTERVAL_MS } from '../worker/poll'
import type { ExportRow } from '../worker/claim'

// The export worker's poll schedule, driven by a fake clock: `sleep` advances virtual time
// instead of waiting, so the backoff, its reset on a found job, and the stuck-sweep cadence
// are asserted exactly. No database.

function fakeLoop(script: (ExportRow | null)[], jobMs = 0) {
  let clock = 0
  const sleeps: number[] = []
  const sweeps: number[] = []
  const jobs: string[] = []
  let polls = 0
  const done = runWorkerLoop({
    claimNext: async () => script[polls++] ?? null,
    failStuck: async () => {
      sweeps.push(clock)
      return []
    },
    runJob: async (row) => {
      jobs.push(row.id)
      clock += jobMs
      return 'succeeded'
    },
    now: () => clock,
    sleep: async (ms) => {
      sleeps.push(ms)
      clock += ms
    },
    shouldStop: () => polls >= script.length,
  })
  return { done, sleeps, sweeps, jobs }
}

const row = (id: string) => ({ id }) as ExportRow

test('nextIdleDelay doubles from the base and caps at the ceiling', () => {
  expect(nextIdleDelay(EXPORT_POLL_MS)).toBe(EXPORT_POLL_MS * 2)
  expect(nextIdleDelay(IDLE_BACKOFF_MAX_MS)).toBe(IDLE_BACKOFF_MAX_MS)
  expect(nextIdleDelay(40_000)).toBe(IDLE_BACKOFF_MAX_MS)
})

test('an idle queue backs off to the ceiling, and a found job resets it to the base', async () => {
  const nulls = (n: number) => Array<ExportRow | null>(n).fill(null)
  const loop = fakeLoop([...nulls(6), row('a'), ...nulls(2)])
  await loop.done
  expect(loop.jobs).toEqual(['a'])
  // Six empty polls back off; the job re-polls with no sleep; the next empty poll is back at the base.
  expect(loop.sleeps).toEqual([4000, 8000, 16000, 32000, 60000, 60000, 4000, 8000])
})

test('the stuck sweep runs at most once per sweep interval, starting on the first tick', async () => {
  const loop = fakeLoop(Array<ExportRow | null>(20).fill(null))
  await loop.done
  expect(loop.sweeps[0]).toBe(0)
  for (let i = 1; i < loop.sweeps.length; i++) {
    expect(loop.sweeps[i] - loop.sweeps[i - 1]).toBeGreaterThanOrEqual(STUCK_SWEEP_INTERVAL_MS)
  }
  // Fewer sweeps than polls once the backoff is under the sweep interval.
  expect(loop.sweeps.length).toBeLessThan(20)
})

test('a long job counts toward the sweep interval, so the next tick sweeps', async () => {
  const loop = fakeLoop([null, row('long'), null], STUCK_SWEEP_INTERVAL_MS)
  await loop.done
  expect(loop.sweeps).toEqual([0, 4000 + STUCK_SWEEP_INTERVAL_MS])
})
