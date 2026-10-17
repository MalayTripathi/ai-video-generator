import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/lib/database.types'
import { displayTitle } from '@/lib/display-title'
import { removeStorageUnder } from '@/lib/storage/sweep'
import { HOLD_KEY_PREFIX, SETTLE_KEY_PREFIX, settleHold } from '@/lib/credits/ledger'
import type { Step, Operation } from '@/lib/config/pipeline'
import { checkProjectActivity } from './deletion-guard'

// Deleting a project, in a fixed order:
//   1. ownership (the caller's client; a missing or foreign project is a 404);
//   2. the activity check - anything live refuses with 409, and a dead run's hold is
//      released first (deletion-guard.ts);
//   3. the deleted_projects row (service role), keyed by the project's own id, so credit
//      and usage history can still name it;
//   4. the projects row (service role - there is no client DELETE policy); its child rows
//      cascade. credit_ledger and usage hold plain ids and are never touched;
//   5. a re-read of the project's holds: one placed after the activity check (a generation
//      that started in that window) is refunded in full through settleHold - its run went
//      with the project, so nothing else ever could. Holds a charged run had closed are
//      skipped (the check returned them);
//   6. the storage sweep of `{userId}/{projectId}/`, then storage_purged_at. A failed sweep
//      leaves it null and is retried on the user's next deletion and by the cleanup script.
// If step 4 fails after step 3, the live projects row stays the source of truth: readers
// check projects first, so the project never shows as deleted.

type Client = SupabaseClient<Database>

export type DeleteProjectResult =
  | { ok: true; status: 200 }
  | { ok: false; status: 404 | 409 | 500; error: string; code?: 'active' }

export const PROJECT_ACTIVE_MESSAGE = 'A generation is running in this project. Wait for it to finish, then delete.'

export async function deleteProject(params: {
  supabase: Client
  service: Client
  userId: string
  projectId: string
  /** Test seam: runs between the activity check and the delete, where a late start lands. */
  afterActivityCheck?: () => Promise<void>
}): Promise<DeleteProjectResult> {
  const { supabase, service, userId, projectId } = params
  const { data: project, error: readError } = await supabase
    .from('projects')
    .select('id, title, source_text, duration_target, furthest_step, created_at, shots(count)')
    .eq('id', projectId)
    .eq('user_id', userId)
    .maybeSingle()
  if (readError) return { ok: false, status: 500, error: readError.message }
  if (!project) return { ok: false, status: 404, error: 'Project not found' }

  const activity = await checkProjectActivity(supabase, projectId, userId)
  if (activity.active) {
    if (activity.reason === 'error') return { ok: false, status: 500, error: activity.error }
    return { ok: false, status: 409, error: PROJECT_ACTIVE_MESSAGE, code: 'active' }
  }
  await params.afterActivityCheck?.()

  const { error: recordError } = await service.from('deleted_projects').upsert({
    id: project.id,
    user_id: userId,
    title: displayTitle(project),
    shot_count: (project.shots as unknown as { count: number }[])[0]?.count ?? 0,
    duration_tier: project.duration_target,
    furthest_step: project.furthest_step,
    created_at: project.created_at,
    deleted_at: new Date().toISOString(),
    storage_purged_at: null,
  })
  if (recordError) return { ok: false, status: 500, error: recordError.message }

  const { error: deleteError } = await service.from('projects').delete().eq('id', projectId).eq('user_id', userId)
  if (deleteError) return { ok: false, status: 500, error: deleteError.message }

  await releaseLeftoverHolds(service, userId, projectId, activity.closedHoldIds)
  await purgeProjectStorage(service, userId, projectId)
  await retryUnpurged(service, userId, projectId)
  return { ok: true, status: 200 }
}

/**
 * Refunds every hold of a deleted project still unsettled, except those a charged run had
 * closed before the delete. settleHold's settle:{hold id} key means a worker that later
 * settles the same hold writes nothing twice. Never throws.
 */
async function releaseLeftoverHolds(service: Client, userId: string, projectId: string, closedHoldIds: readonly string[]) {
  try {
    const [holds, settles] = await Promise.all([
      service
        .from('credit_ledger')
        .select('id, attempt_id, step, operation, pricing_mode, message_id')
        .eq('user_id', userId)
        .eq('project_id', projectId)
        .eq('kind', 'spend')
        .like('dedupe_key', `${HOLD_KEY_PREFIX}%`),
      service.from('credit_ledger').select('dedupe_key').eq('user_id', userId).eq('project_id', projectId).like('dedupe_key', `${SETTLE_KEY_PREFIX}%`),
    ])
    if (holds.error || settles.error) throw new Error(holds.error?.message ?? settles.error?.message)
    const settled = new Set((settles.data ?? []).map((r) => r.dedupe_key.slice(SETTLE_KEY_PREFIX.length)))
    const closed = new Set(closedHoldIds)
    for (const hold of holds.data ?? []) {
      if (settled.has(hold.id) || closed.has(hold.id) || hold.attempt_id === null) continue
      console.warn(`[projects] hold ${hold.id} of deleted project ${projectId} was still open - refunding it in full`)
      await settleHold({
        userId,
        attemptId: hold.attempt_id,
        step: hold.step as Step,
        operation: hold.operation as Operation,
        pricingMode: (hold.pricing_mode as 'fixed' | 'dynamic' | null) ?? 'fixed',
        projectId,
        messageId: hold.message_id,
        actualCredits: 0,
      })
    }
  } catch (err) {
    console.error(`[projects] could not release the holds of deleted project ${projectId}`, err)
  }
}

/** Sweeps one deleted project's prefix and stamps storage_purged_at. Never throws. */
export async function purgeProjectStorage(service: Client, userId: string, projectId: string): Promise<boolean> {
  try {
    await removeStorageUnder(service, `${userId}/${projectId}`)
    const { error } = await service
      .from('deleted_projects')
      .update({ storage_purged_at: new Date().toISOString() })
      .eq('id', projectId)
      .eq('user_id', userId)
    if (error) throw new Error(error.message)
    return true
  } catch (err) {
    console.error(`[projects] storage sweep failed for deleted project ${projectId}`, err)
    return false
  }
}

/**
 * Retries the sweep for the user's earlier deletions still unpurged - skipping any whose
 * projects row still exists (its delete failed, so it is live). Never throws.
 */
export async function retryUnpurged(service: Client, userId: string, exceptProjectId?: string): Promise<void> {
  const { data: pending, error } = await service
    .from('deleted_projects')
    .select('id')
    .eq('user_id', userId)
    .is('storage_purged_at', null)
  if (error) {
    console.error(`[projects] could not read unpurged deletions for user ${userId}`, error.message)
    return
  }
  const ids = (pending ?? []).map((r) => r.id).filter((id) => id !== exceptProjectId)
  if (ids.length === 0) return
  const { data: live, error: liveError } = await service.from('projects').select('id').in('id', ids)
  if (liveError) return
  const liveIds = new Set((live ?? []).map((r) => r.id))
  for (const id of ids) if (!liveIds.has(id)) await purgeProjectStorage(service, userId, id)
}
