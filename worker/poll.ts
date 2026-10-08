import { EXPORT_POLL_MS } from '@/lib/config/export'
import type { ExportRow } from './claim'

// The worker's poll schedule, with time injected so it can be driven by a fake clock.
// Busy: re-poll at once after a job, every EXPORT_POLL_MS once the queue empties. Idle: each
// empty poll doubles the wait up to IDLE_BACKOFF_MAX_MS; a found job resets it. The stuck
// sweep runs at most once per STUCK_SWEEP_INTERVAL_MS - its timeout is unchanged.

export const IDLE_BACKOFF_MAX_MS = 60_000
export const STUCK_SWEEP_INTERVAL_MS = 60_000

export function nextIdleDelay(prev: number, base: number = EXPORT_POLL_MS): number {
  return Math.min(Math.max(prev, base) * 2, IDLE_BACKOFF_MAX_MS)
}

export type WorkerLoopDeps = {
  claimNext: () => Promise<ExportRow | null>
  failStuck: () => Promise<string[]>
  runJob: (row: ExportRow) => Promise<'succeeded' | 'failed'>
  now: () => number
  sleep: (ms: number) => Promise<void>
  shouldStop: () => boolean
  baseMs?: number
}

export async function runWorkerLoop(deps: WorkerLoopDeps): Promise<void> {
  const base = deps.baseMs ?? EXPORT_POLL_MS
  let idleDelay = base
  let lastSweep = Number.NEGATIVE_INFINITY
  while (!deps.shouldStop()) {
    try {
      if (deps.now() - lastSweep >= STUCK_SWEEP_INTERVAL_MS) {
        lastSweep = deps.now()
        const stuck = await deps.failStuck()
        if (stuck.length > 0) console.warn('[export] marked stuck exports failed', stuck)
      }
      const row = await deps.claimNext()
      if (row) {
        console.log('[export] rendering', row.id)
        const result = await deps.runJob(row)
        console.log('[export]', result, row.id)
        idleDelay = base
        continue
      }
    } catch (err) {
      console.error('[export] poll failed', err instanceof Error ? err.message : err)
    }
    await deps.sleep(idleDelay)
    idleDelay = nextIdleDelay(idleDelay, base)
  }
}
