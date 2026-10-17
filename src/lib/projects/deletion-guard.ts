import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/lib/database.types'
import type { Operation } from '@/lib/config/pipeline'
import { isLiveClaim } from '@/lib/generations/claim'
import { isLiveShotRun } from '@/lib/shots/runs'
import { HOLD_KEY_PREFIX, SETTLE_KEY_PREFIX } from '@/lib/credits/ledger'
import { releaseStaleHolds } from '@/lib/credits/release-stale-holds'

// The one check before a project is deleted: nothing may still be running in it, and no
// credits may still be held for it. A deleted project must never leave a hold open - its
// shot runs go with it, so nothing could ever settle that hold afterwards.
//
// Refused while any of these holds: a live claim (isLiveClaim), a running shot run, an
// export queued or rendering, an open hold. A dead run's hold is released first through the
// existing settle path (releaseStaleHolds -> settleDeadShotRuns / settleHold), so only a
// hold that is genuinely still open refuses. Reads use the caller's client (RLS scopes them
// to the user); the settles go through ledger.ts's service-role writers.

type Client = SupabaseClient<Database>

export type ProjectActivity =
  /** closedHoldIds: unsettled holds a charged run closed - the run goes with the project,
   * so the post-delete release must know these were never open. */
  | { active: false; closedHoldIds: string[] }
  | { active: true; reason: 'claim' | 'shot_run' | 'export' | 'hold' }
  | { active: true; reason: 'error'; error: string }

const ACTIVE_EXPORT_STATUSES = ['queued', 'rendering']

export async function checkProjectActivity(supabase: Client, projectId: string, userId: string): Promise<ProjectActivity> {
  const [claims, runs, exportsRead] = await Promise.all([
    supabase.from('generations').select('operation, state, started_at, queued_at').eq('project_id', projectId).eq('state', 'generating'),
    supabase.from('shot_runs').select('status, heartbeat_at').eq('project_id', projectId).eq('status', 'running'),
    supabase.from('exports').select('id').eq('project_id', projectId).in('status', ACTIVE_EXPORT_STATUSES).limit(1),
  ])
  const readError = claims.error ?? runs.error ?? exportsRead.error
  if (readError) return { active: true, reason: 'error', error: readError.message }
  if ((claims.data ?? []).some((g) => isLiveClaim(g, g.operation as Operation))) return { active: true, reason: 'claim' }
  if ((runs.data ?? []).some((r) => isLiveShotRun(r))) return { active: true, reason: 'shot_run' }
  if ((exportsRead.data ?? []).length > 0) return { active: true, reason: 'export' }

  // Dead runs settle and run-less holds past their window refund - the same release every
  // balance read performs, run unconditionally here.
  await releaseStaleHolds(supabase, userId)
  return (await hasOpenHold(supabase, projectId, userId)) ?? { active: true, reason: 'error', error: 'Could not read holds' }
}

/** The project's holds still open after the release: unsettled, and not closed by a charged run. */
async function hasOpenHold(supabase: Client, projectId: string, userId: string): Promise<ProjectActivity | null> {
  const [holds, settles] = await Promise.all([
    supabase
      .from('credit_ledger')
      .select('id, attempt_id')
      .eq('user_id', userId)
      .eq('project_id', projectId)
      .eq('kind', 'spend')
      .like('dedupe_key', `${HOLD_KEY_PREFIX}%`),
    supabase.from('credit_ledger').select('dedupe_key').eq('user_id', userId).eq('project_id', projectId).like('dedupe_key', `${SETTLE_KEY_PREFIX}%`),
  ])
  if (holds.error || settles.error) return null
  const settled = new Set((settles.data ?? []).map((r) => r.dedupe_key.slice(SETTLE_KEY_PREFIX.length)))
  const unsettled = (holds.data ?? []).filter((h) => !settled.has(h.id))
  if (unsettled.length === 0) return { active: false, closedHoldIds: [] }
  const attempts = unsettled.map((h) => h.attempt_id).filter((a): a is string => a !== null)
  const { data: runRows, error } = attempts.length
    ? await supabase.from('shot_runs').select('attempt_id, charged_at').in('attempt_id', attempts)
    : { data: [], error: null }
  if (error) return null
  const charged = new Set((runRows ?? []).filter((r) => r.charged_at !== null).map((r) => r.attempt_id))
  const open = unsettled.some((h) => h.attempt_id === null || !charged.has(h.attempt_id))
  return open ? { active: true, reason: 'hold' } : { active: false, closedHoldIds: unsettled.map((h) => h.id) }
}
