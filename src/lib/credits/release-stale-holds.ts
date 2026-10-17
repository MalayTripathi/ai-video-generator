import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/lib/database.types'
import { SHOT_RUN_STALE_AFTER_MS } from '@/lib/config/shots'
import type { Step, Operation } from '@/lib/config/pipeline'
import { HOLD_KEY_PREFIX, SETTLE_KEY_PREFIX, placeHold, settleHold } from './ledger'
import { readBalance, type BalanceRead } from './balance'
import { SETTLE_RUN_COLUMNS, settleDeadShotRuns, type SettleRunRow, type ShotRunLedger } from '@/lib/shots/runs'

// Releasing dead holds, per user. A hold stays open from its action's start until its settle;
// a chain that dies would leave it locking the user's credits until something touches its
// project again - so any balance read that sees one of the user's open holds past its stale
// window releases it, whichever project it belongs to. The gate rides on the balance read's
// own column (credit_balances.open_hold_live_at), so the normal path is that one query. Reads
// and run writes use the caller's own client (RLS scopes both to the user); only the ledger's
// settles go through ledger.ts's service-role writers.

const LEDGER: ShotRunLedger = { placeHold, settleHold }

/** Whether a balance read says one of the user's open holds is past its stale window. */
export function hasStaleHold(read: Pick<BalanceRead, 'openHoldLiveAt'>, now: number = Date.now()): boolean {
  return read.openHoldLiveAt !== null && new Date(read.openHoldLiveAt).getTime() <= now - SHOT_RUN_STALE_AFTER_MS
}

/**
 * Settles every dead run behind the user's open holds, across all their projects, and
 * refunds a hold left with no run at all (its start failed after the hold was placed).
 * Runs are settled through settleDeadShotRuns, which never touches a live one. Every query
 * is scoped by the user's id as well as by RLS.
 */
export async function releaseStaleHolds(supabase: SupabaseClient<Database>, userId: string): Promise<void> {
  const [holdsResult, settlesResult] = await Promise.all([
    supabase
      .from('credit_ledger')
      .select('id, attempt_id, created_at, step, operation, pricing_mode, project_id, message_id')
      .eq('user_id', userId)
      .eq('kind', 'spend')
      .like('dedupe_key', `${HOLD_KEY_PREFIX}%`),
    supabase.from('credit_ledger').select('dedupe_key').eq('user_id', userId).like('dedupe_key', `${SETTLE_KEY_PREFIX}%`),
  ])
  if (holdsResult.error || settlesResult.error) {
    console.error('[credits] could not read holds to release', holdsResult.error?.message ?? settlesResult.error?.message)
    return
  }
  const settled = new Set((settlesResult.data ?? []).map((r) => r.dedupe_key.slice(SETTLE_KEY_PREFIX.length)))
  const open = (holdsResult.data ?? []).filter((h) => !settled.has(h.id) && h.attempt_id !== null)
  if (open.length === 0) return

  const { data: runData, error: runError } = await supabase
    .from('shot_runs')
    .select(SETTLE_RUN_COLUMNS)
    .in('attempt_id', open.map((h) => h.attempt_id!))
  if (runError) {
    console.error('[credits] could not read the runs behind open holds', runError.message)
    return
  }
  const runs = (runData ?? []) as unknown as SettleRunRow[]
  const byProject = new Map<string, SettleRunRow[]>()
  for (const run of runs) {
    if (run.charged_at !== null || run.projects.user_id !== userId) continue
    byProject.set(run.project_id, [...(byProject.get(run.project_id) ?? []), run])
  }
  for (const [projectId, projectRuns] of byProject) {
    await settleDeadShotRuns(supabase, LEDGER, projectId, projectRuns)
  }

  const withRun = new Set(runs.map((r) => r.attempt_id))
  const cutoff = Date.now() - SHOT_RUN_STALE_AFTER_MS
  const runless = open.filter((h) => !withRun.has(h.attempt_id!) && new Date(h.created_at).getTime() <= cutoff)
  if (runless.length === 0) return
  // A hold settled at exactly its amount is closed only by its run's charged_at; deleting the
  // project removes that run. Deletion closes every hold first, so a deleted project's hold is
  // never open - the same exclusion credit_balances makes.
  const runlessProjects = [...new Set(runless.map((h) => h.project_id).filter((id): id is string => id !== null))]
  const { data: deletedRows, error: deletedError } = runlessProjects.length
    ? await supabase.from('deleted_projects').select('id').in('id', runlessProjects)
    : { data: [], error: null }
  if (deletedError) {
    console.error('[credits] could not read deleted projects behind open holds', deletedError.message)
    return
  }
  const deleted = new Set((deletedRows ?? []).map((r) => r.id))
  for (const hold of runless) {
    if (hold.project_id !== null && deleted.has(hold.project_id)) continue
    console.warn(`[credits] hold ${hold.id} has no run - refunding it in full`)
    await settleHold({
      userId,
      attemptId: hold.attempt_id!,
      step: hold.step as Step,
      operation: hold.operation as Operation,
      pricingMode: (hold.pricing_mode as 'fixed' | 'dynamic' | null) ?? 'fixed',
      projectId: hold.project_id,
      messageId: hold.message_id,
      actualCredits: 0,
    })
  }
}

/**
 * The user's balance, with any dead run's hold released first - but only when the balance
 * read itself says one is past its stale window; otherwise this is exactly one query. Every
 * balance shown (the rail, /credits, intake) and every credit check before a hold reads it.
 */
export async function readSettledBalance(
  supabase: SupabaseClient<Database>,
  userId: string,
  options: { fresh?: boolean } = {}
): Promise<BalanceRead> {
  const read = await readBalance(supabase, userId, options)
  if (!hasStaleHold(read)) return read
  try {
    await releaseStaleHolds(supabase, userId)
  } catch (err) {
    // Never fails the read it rides on: the balance shown is just the pre-release one.
    console.error('[credits] releasing stale holds failed', err)
    return read
  }
  return readBalance(supabase, userId, { fresh: true })
}
