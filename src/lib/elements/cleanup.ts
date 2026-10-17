import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database, Tables } from '@/lib/database.types'
import type { Operation } from '@/lib/config/pipeline'
import { isLiveClaim } from '@/lib/generations/claim'
import { isForeignKeyViolation } from '@/lib/shot-key'
import { discardFolderExcept, projectPrefix } from '@/lib/storage/replaced'

// The end-of-run cleanup of a plan made from scratch (the agent's regenerate-all, the intake
// Build, Try again - never Generate remaining shots): elements the new shot list no longer
// uses are deleted outright, so Assets doesn't keep the old plan's cast. Protected, always:
// the style, an element a person made or changed, one with a reference image (or one being
// made), and every name the outline gave a scene not yet written - Generate remaining shots
// still needs those.
//
// shot_elements and shot_dialogue cascade on an element's delete, so an element either still
// points at is kept. generations does not cascade (NO ACTION): a removal first deletes the
// element's finished generations rows - never a live claim, and in cleanup never one holding
// a payload (paid output) - then the element. A reference claim inserted in between makes
// that delete fail with 23503, and the element is kept. The delete repeats every protection
// in its own filter: a person attaching an element marks it edited before linking it
// (workbench actions.ts), so an attach or an edit that lands after the read is never lost.
// The element's storage files go last, under the replaced-file rules.

type Client = SupabaseClient<Database>

export type CleanupCandidate = Pick<
  Tables<'elements'>,
  'id' | 'name' | 'type' | 'origin' | 'user_edited_at' | 'reference_image_path' | 'status'
> & { shot_elements: { count: number }[]; shot_dialogue: { count: number }[] }

const count = (rows: { count: number }[] | undefined) => rows?.[0]?.count ?? 0

/** Whether an element is protected - never removed, whatever points at it. */
export function isProtectedElement(el: CleanupCandidate, keepLowerNames: ReadonlySet<string>): boolean {
  return (
    el.type === 'style' ||
    el.origin !== 'model' ||
    el.user_edited_at !== null ||
    el.reference_image_path !== null ||
    el.status !== 'pending' ||
    keepLowerNames.has(el.name.trim().toLowerCase())
  )
}

/** Whether a shot still links the element or a line is spoken by it (its delete would cascade them). */
export function isReferencedElement(el: CleanupCandidate): boolean {
  return count(el.shot_elements) > 0 || count(el.shot_dialogue) > 0
}

/** Whether an element may be removed: unprotected and unreferenced. */
export function isRemovableElement(el: CleanupCandidate, keepLowerNames: ReadonlySet<string>): boolean {
  return !isProtectedElement(el, keepLowerNames) && !isReferencedElement(el)
}

export type ElementRemoval = 'removed' | 'live_claim' | 'paid_output' | 'kept' | 'failed'

/**
 * Hard-deletes one element: its finished generations rows, then the row, then its files.
 * `supabase` comes from the caller and must be able to delete generations rows - there is no
 * client DELETE policy, so it is the service-role client (the shot chain's, or the one
 * delete-for-user.ts builds after its ownership check). `keepPaidOutput` (cleanup) keeps
 * an element whose generations rows hold a payload; a person's own delete passes false.
 * `protect` (cleanup) repeats every protection in the delete's filter. Never throws.
 */
export async function removeElement(
  supabase: Client,
  params: { userId: string; projectId: string; elementId: string; keepPaidOutput: boolean; protect: boolean }
): Promise<ElementRemoval> {
  const { userId, projectId, elementId } = params
  try {
    const { data: gens, error: readError } = await supabase
      .from('generations')
      .select('id, operation, state, started_at, queued_at, payload')
      .eq('project_id', projectId)
      .eq('element_id', elementId)
    if (readError) throw new Error(readError.message)
    const rows = gens ?? []
    if (rows.some((g) => isLiveClaim(g, g.operation as Operation))) return 'live_claim'
    if (params.keepPaidOutput && rows.some((g) => g.payload !== null)) return 'paid_output'
    if (rows.length > 0) {
      const { error } = await supabase
        .from('generations')
        .delete()
        .eq('project_id', projectId)
        .in(
          'id',
          rows.map((g) => g.id)
        )
      if (error) throw new Error(error.message)
    }

    let del = supabase.from('elements').delete().eq('project_id', projectId).eq('id', elementId)
    if (params.protect) {
      del = del
        .is('deleted_at', null)
        .neq('type', 'style')
        .eq('origin', 'model')
        .is('user_edited_at', null)
        .is('reference_image_path', null)
        .eq('status', 'pending')
    }
    const { data, error } = await del.select('id')
    if (error) {
      if (isForeignKeyViolation(error)) {
        console.warn(`[elements] element ${elementId} kept - a generation started for it as it was being deleted`)
        return 'live_claim'
      }
      throw new Error(error.message)
    }
    if ((data ?? []).length === 0) return 'kept'

    await discardFolderExcept({
      userId,
      projectId,
      folder: `${projectPrefix(userId, projectId)}elements/${elementId}`,
      keep: [],
    })
    return 'removed'
  } catch (err) {
    console.error(`[elements] removing element ${elementId} failed in project ${projectId}`, err)
    return 'failed'
  }
}

/**
 * The cleanup's delete: each id through removeElement with every protection re-checked at
 * delete time, paid output kept. Returns the ids it removed. Exported so a test can run it
 * after a concurrent attach.
 */
export async function deleteUnprotectedElements(
  supabase: Client,
  projectId: string,
  userId: string,
  ids: readonly string[]
): Promise<string[]> {
  const outcomes = await Promise.all(
    ids.map(async (elementId) => ({
      elementId,
      outcome: await removeElement(supabase, { userId, projectId, elementId, keepPaidOutput: true, protect: true }),
    }))
  )
  const paid = outcomes.filter((o) => o.outcome === 'paid_output').map((o) => o.elementId)
  if (paid.length > 0) {
    console.warn(`[elements] cleanup kept ${paid.length} element(s) in project ${projectId} whose generations hold paid output: ${paid.join(', ')}`)
  }
  return outcomes.filter((o) => o.outcome === 'removed').map((o) => o.elementId)
}

/**
 * Deletes the project's removable elements. `keepNames` is every element name the outline
 * gave a scene not yet written. Never throws: a failed cleanup leaves the elements in
 * Assets, which costs nothing. Returns the ids removed.
 */
export async function removeUnusedElements(
  supabase: Client,
  projectId: string,
  userId: string,
  keepNames: readonly string[]
): Promise<string[]> {
  const { data, error } = await supabase
    .from('elements')
    .select('id, name, type, origin, user_edited_at, reference_image_path, status, shot_elements(count), shot_dialogue(count)')
    .eq('project_id', projectId)
    .is('deleted_at', null)
  if (error) {
    console.error(`[elements] cleanup read failed for project ${projectId}`, error.message)
    return []
  }
  const keep = new Set(keepNames.map((n) => n.trim().toLowerCase()))
  const removable = ((data ?? []) as unknown as CleanupCandidate[]).filter((el) => isRemovableElement(el, keep))
  return deleteUnprotectedElements(
    supabase,
    projectId,
    userId,
    removable.map((el) => el.id)
  )
}
