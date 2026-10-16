import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database, Tables } from '@/lib/database.types'

// The end-of-run cleanup of a plan made from scratch (the agent's regenerate-all, the intake
// Build, Try again - never Generate remaining shots): elements the new shot list no longer
// uses are deleted outright, so Assets doesn't keep the old plan's cast. Protected, always:
// the style, an element a person made or changed, one with a reference image (or one being
// made), and every name the outline gave a scene not yet written - Generate remaining shots
// still needs those.
//
// Every table that points at an element (shot_elements, shot_dialogue, generations) cascades
// on its delete, so an element anything still points at is skipped and logged, never deleted
// with its references. The delete is one statement that repeats every protection in its own
// filter: a person attaching an element marks it edited before linking it (workbench
// actions.ts), so an attach or an edit that lands after the read is never lost.

type Client = SupabaseClient<Database>

export type CleanupCandidate = Pick<
  Tables<'elements'>,
  'id' | 'name' | 'type' | 'origin' | 'user_edited_at' | 'reference_image_path' | 'status'
> & { shot_elements: { count: number }[]; shot_dialogue: { count: number }[]; generations: { count: number }[] }

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

/** Whether any table still points at an element (its delete would cascade). */
export function isReferencedElement(el: CleanupCandidate): boolean {
  return count(el.shot_elements) > 0 || count(el.shot_dialogue) > 0 || count(el.generations) > 0
}

/** Whether an element may be removed: unprotected and unreferenced. */
export function isRemovableElement(el: CleanupCandidate, keepLowerNames: ReadonlySet<string>): boolean {
  return !isProtectedElement(el, keepLowerNames) && !isReferencedElement(el)
}

/**
 * The delete itself: one statement over `ids`, re-checking every protection at delete time.
 * Returns the ids it removed. Exported so a test can run it after a concurrent attach.
 */
export async function deleteUnprotectedElements(supabase: Client, projectId: string, ids: readonly string[]): Promise<string[]> {
  if (ids.length === 0) return []
  const { data, error } = await supabase
    .from('elements')
    .delete()
    .eq('project_id', projectId)
    .in('id', [...ids])
    .is('deleted_at', null)
    .neq('type', 'style')
    .eq('origin', 'model')
    .is('user_edited_at', null)
    .is('reference_image_path', null)
    .eq('status', 'pending')
    .select('id')
  if (error) {
    console.error(`[elements] cleanup failed for project ${projectId}`, error.message)
    return []
  }
  return (data ?? []).map((r) => r.id)
}

/**
 * Deletes the project's removable elements. `keepNames` is every element name the outline
 * gave a scene not yet written. Never throws: a failed cleanup leaves the elements in
 * Assets, which costs nothing. Returns the ids removed.
 */
export async function removeUnusedElements(supabase: Client, projectId: string, keepNames: readonly string[]): Promise<string[]> {
  const { data, error } = await supabase
    .from('elements')
    .select(
      'id, name, type, origin, user_edited_at, reference_image_path, status, shot_elements(count), shot_dialogue(count), generations(count)'
    )
    .eq('project_id', projectId)
    .is('deleted_at', null)
  if (error) {
    console.error(`[elements] cleanup read failed for project ${projectId}`, error.message)
    return []
  }
  const keep = new Set(keepNames.map((n) => n.trim().toLowerCase()))
  const unprotected = ((data ?? []) as unknown as CleanupCandidate[]).filter((el) => !isProtectedElement(el, keep))
  // In use (a shot links it, or a line is spoken by it) is the normal reason to keep one; an
  // unused one something else still points at is the skip worth a log line.
  const referenced = unprotected.filter(
    (el) => isReferencedElement(el) && count(el.shot_elements) === 0 && count(el.shot_dialogue) === 0
  )
  if (referenced.length > 0) {
    console.warn(
      `[elements] cleanup skipped ${referenced.length} referenced element(s) in project ${projectId}: ${referenced
        .map((el) => `${el.id} (generations ${count(el.generations)})`)
        .join(', ')}`
    )
  }
  return deleteUnprotectedElements(
    supabase,
    projectId,
    unprotected.filter((el) => !isReferencedElement(el)).map((el) => el.id)
  )
}
