'use server'

import { createClient } from '@/lib/supabase/server'
import { SHOT_SIZES, CAMERA_ANGLES, CAMERA_MOVEMENTS } from '@/lib/config/enums'
import { stalenessFor } from '@/lib/shot-staleness'
import { stepIndex } from '@/lib/config/pipeline'
import { voiceOverIsValid, EMPTY_VOICEOVER_MESSAGE } from '@/lib/shot-voiceover'
import { visualDescriptionIsValid, EMPTY_VISUAL_DESCRIPTION_MESSAGE } from '@/lib/shot-visual-description'
import {
  getProjectElementsForUser,
  resignElementReferenceImageForUser,
  type GetProjectElementsResult,
  type ResignElementImageResult,
} from '@/lib/elements/read'

type SupabaseServerClient = Awaited<ReturnType<typeof createClient>>

export type ShotField =
  | 'voice_over'
  | 'visual_description'
  | 'duration_sec'
  | 'shot_size'
  | 'camera_angle'
  | 'camera_movement'

export type ShotFieldSaveResult =
  | { field: ShotField; success: true; unchanged?: true }
  | { field: ShotField; success: false; error: string; reason?: 'invalid' }

export type DialogueSaveResult =
  | { success: true; id: string; unchanged?: true }
  | { success: false; error: string }

export type DialogueDeleteResult = { success: true } | { success: false; error: string }

export type ShotDeleteResult = { success: true } | { success: false; error: string }

// Loads a shot together with its persisted field values, scoped to the caller's own
// project - RLS is the backstop, this is the app-level check (shots has no user_id
// column of its own, so ownership only resolves through the projects join). Null means
// "not found or not owned" - the two collapse to the same result on purpose so a
// mismatched shot_id never leaks which case it was.
async function loadOwnedShot(supabase: SupabaseServerClient, shotId: string, userId: string) {
  const { data } = await supabase
    .from('shots')
    .select(
      'id, project_id, voice_over, visual_description, duration_sec, shot_size, shot_size_origin, camera_angle, camera_angle_origin, camera_movement, camera_movement_origin, projects!inner(user_id)'
    )
    .eq('id', shotId)
    .eq('projects.user_id', userId)
    .maybeSingle()
  return data
}

export async function updateShotVoiceOver(shotId: string, value: string): Promise<ShotFieldSaveResult> {
  const field: ShotField = 'voice_over'
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return { field, success: false, error: 'Not authenticated' }

  const shot = await loadOwnedShot(supabase, shotId, user.id)
  if (!shot) return { field, success: false, error: 'Shot not found' }

  const trimmed = value.trim()

  // Defense-in-depth: the client already refuses to call this action with an
  // unacceptable value, but the agent path and any direct call must not be able to
  // bypass it. Only queries shot_dialogue when the value is actually empty (the common
  // case never pays for it), and checked unconditionally otherwise - not gated on "did
  // it change" - for the same reason as the client check (see voiceover-field.tsx).
  if (trimmed === '') {
    const { count } = await supabase
      .from('shot_dialogue')
      .select('id', { count: 'exact', head: true })
      .eq('shot_id', shotId)
    if (!voiceOverIsValid(trimmed, (count ?? 0) > 0)) {
      return { field, success: false, reason: 'invalid', error: EMPTY_VOICEOVER_MESSAGE }
    }
  }

  if (trimmed === shot.voice_over) return { field, success: true, unchanged: true }

  const staleness = stalenessFor('voice_over')

  const { error } = await supabase
    .from('shots')
    .update({ voice_over: trimmed, ...staleness.shot })
    .eq('id', shotId)
  if (error) return { field, success: false, error: error.message }

  // Separate table, separate call - no cross-table transaction is available without an
  // RPC (banned in this repo). The shots write above is the primary artifact and has
  // already succeeded; a failure here is logged but doesn't turn the field save into a
  // failure the user has to retry - the text itself is safely persisted either way.
  const { error: projectError } = await supabase
    .from('projects')
    .update(staleness.project)
    .eq('id', shot.project_id)
  if (projectError) {
    console.error(
      `[workbench] Failed to set voiceover_stale for project ${shot.project_id}:`,
      projectError.message
    )
  }

  return { field, success: true }
}

export async function updateShotVisualDescription(
  shotId: string,
  value: string
): Promise<ShotFieldSaveResult> {
  const field: ShotField = 'visual_description'
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return { field, success: false, error: 'Not authenticated' }

  const shot = await loadOwnedShot(supabase, shotId, user.id)
  if (!shot) return { field, success: false, error: 'Shot not found' }

  const trimmed = value.trim()

  // Defense-in-depth, same shape as updateShotVoiceOver's - the client already refuses to
  // call this action with an empty value, but the agent path and any direct call must not
  // be able to bypass it. Checked unconditionally, not gated on "did it change" - an
  // already-persisted empty description must still be refused, not just the edit that
  // created it.
  if (!visualDescriptionIsValid(trimmed)) {
    return { field, success: false, reason: 'invalid', error: EMPTY_VISUAL_DESCRIPTION_MESSAGE }
  }

  const persisted = shot.visual_description ?? ''
  if (trimmed === persisted) return { field, success: true, unchanged: true }

  const { error } = await supabase
    .from('shots')
    .update({ visual_description: trimmed, ...stalenessFor('visual_description').shot })
    .eq('id', shotId)
  if (error) return { field, success: false, error: error.message }

  return { field, success: true }
}

export async function updateShotDuration(shotId: string, value: number): Promise<ShotFieldSaveResult> {
  const field: ShotField = 'duration_sec'
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return { field, success: false, error: 'Not authenticated' }

  const shot = await loadOwnedShot(supabase, shotId, user.id)
  if (!shot) return { field, success: false, error: 'Shot not found' }

  const rounded = Math.round(value * 10) / 10
  if (rounded === shot.duration_sec) return { field, success: true, unchanged: true }

  // No staleness is set for a duration edit - see CLAUDE.md's staleness table. Locking
  // the duration is the whole point of this write: it protects the value from Step 3's
  // voiceover-writeback, which only touches shots where duration_locked is false.
  const { error } = await supabase
    .from('shots')
    .update({ duration_sec: rounded, duration_locked: true })
    .eq('id', shotId)
  if (error) return { field, success: false, error: error.message }

  return { field, success: true }
}

type CameraField = 'shot_size' | 'camera_angle' | 'camera_movement'

const CAMERA_ORIGIN_COLUMN: Record<CameraField, 'shot_size_origin' | 'camera_angle_origin' | 'camera_movement_origin'> = {
  shot_size: 'shot_size_origin',
  camera_angle: 'camera_angle_origin',
  camera_movement: 'camera_movement_origin',
}

const CAMERA_ENUM: Record<CameraField, readonly string[]> = {
  shot_size: SHOT_SIZES,
  camera_angle: CAMERA_ANGLES,
  camera_movement: CAMERA_MOVEMENTS,
}

async function updateCameraField(field: CameraField, shotId: string, value: string): Promise<ShotFieldSaveResult> {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return { field, success: false, error: 'Not authenticated' }

  if (!CAMERA_ENUM[field].includes(value)) return { field, success: false, error: `Invalid ${field} value` }

  const shot = await loadOwnedShot(supabase, shotId, user.id)
  if (!shot) return { field, success: false, error: 'Shot not found' }

  const originColumn = CAMERA_ORIGIN_COLUMN[field]
  // Diff on the (value, origin) PAIR, not value alone: re-selecting the same value
  // while origin is already 'override' is a real no-op, but the same value while
  // origin is still 'auto'/'derived' is NOT a no-op - origin still needs to move to
  // 'override' to record that a person now owns this field.
  if (shot[field] === value && shot[originColumn] === 'override') {
    return { field, success: true, unchanged: true }
  }

  const { error } = await supabase
    .from('shots')
    .update({ [field]: value, [originColumn]: 'override', ...stalenessFor('camera').shot })
    .eq('id', shotId)
  if (error) return { field, success: false, error: error.message }

  return { field, success: true }
}

export async function updateShotSize(shotId: string, value: string): Promise<ShotFieldSaveResult> {
  return updateCameraField('shot_size', shotId, value)
}

export async function updateShotCameraAngle(shotId: string, value: string): Promise<ShotFieldSaveResult> {
  return updateCameraField('camera_angle', shotId, value)
}

export async function updateShotCameraMovement(shotId: string, value: string): Promise<ShotFieldSaveResult> {
  return updateCameraField('camera_movement', shotId, value)
}

export async function saveDialogueLine(input: {
  id?: string
  shotId: string
  elementId: string
  line: string
}): Promise<DialogueSaveResult> {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return { success: false, error: 'Not authenticated' }

  const { data: shot } = await supabase
    .from('shots')
    .select('id, project_id, projects!inner(user_id)')
    .eq('id', input.shotId)
    .eq('projects.user_id', user.id)
    .maybeSingle()
  if (!shot) return { success: false, error: 'Shot not found' }

  const trimmedLine = input.line.trim()

  if (input.id) {
    const { data: existing } = await supabase
      .from('shot_dialogue')
      .select('id, element_id, line')
      .eq('id', input.id)
      .eq('shot_id', input.shotId)
      .maybeSingle()
    if (!existing) return { success: false, error: 'Dialogue line not found' }

    if (existing.element_id === input.elementId && existing.line === trimmedLine) {
      return { success: true, id: existing.id, unchanged: true }
    }

    const { error } = await supabase
      .from('shot_dialogue')
      .update({ element_id: input.elementId, line: trimmedLine })
      .eq('id', input.id)
    if (error) return { success: false, error: error.message }

    await markVideoPromptStale(supabase, input.shotId)
    return { success: true, id: input.id }
  }

  const { count } = await supabase
    .from('shot_dialogue')
    .select('id', { count: 'exact', head: true })
    .eq('shot_id', input.shotId)

  const { data: inserted, error } = await supabase
    .from('shot_dialogue')
    .insert({
      project_id: shot.project_id,
      shot_id: input.shotId,
      element_id: input.elementId,
      line: trimmedLine,
      order_index: count ?? 0,
    })
    .select('id')
    .single()
  if (error || !inserted) return { success: false, error: error?.message ?? 'Insert failed' }

  await markVideoPromptStale(supabase, input.shotId)
  return { success: true, id: inserted.id }
}

export async function deleteDialogueLine(id: string, shotId: string): Promise<DialogueDeleteResult> {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return { success: false, error: 'Not authenticated' }

  const { data: shot } = await supabase
    .from('shots')
    .select('id, projects!inner(user_id)')
    .eq('id', shotId)
    .eq('projects.user_id', user.id)
    .maybeSingle()
  if (!shot) return { success: false, error: 'Shot not found' }

  const { error: deleteError } = await supabase
    .from('shot_dialogue')
    .delete()
    .eq('id', id)
    .eq('shot_id', shotId)
  if (deleteError) return { success: false, error: deleteError.message }

  // Keep order_index contiguous - no RPC available, so this is a plain re-sequence of
  // whatever remains for this shot.
  const { data: remaining } = await supabase
    .from('shot_dialogue')
    .select('id, order_index')
    .eq('shot_id', shotId)
    .order('order_index', { ascending: true })

  if (remaining) {
    await Promise.all(
      remaining
        .map((row, index) => ({ row, index }))
        .filter(({ row, index }) => row.order_index !== index)
        .map(({ row, index }) => supabase.from('shot_dialogue').update({ order_index: index }).eq('id', row.id))
    )
  }

  await markVideoPromptStale(supabase, shotId)
  return { success: true }
}

async function markVideoPromptStale(supabase: SupabaseServerClient, shotId: string) {
  const { error } = await supabase.from('shots').update(stalenessFor('dialogue').shot).eq('id', shotId)
  if (error) {
    console.error(`[workbench] Failed to set video_prompt_stale for shot ${shotId}:`, error.message)
  }
}

// The user may always delete a shot, whatever has been spent on it - a creative
// decision the app does not override (see docs/decisions.md). Refused only once the
// workbench itself is read-only, the same threshold every other lock check in this
// codebase uses - paid Step 3+ output must never be silently reshaped by a structural
// change like this.
//
// This threshold (`furthest_step >= stepIndex('storyboard')`) is independently
// duplicated in three places with no shared helper to import (see CLAUDE.md's
// COUPLING WARNING pattern for why extracting one here would touch agent-chat files
// this feature must not depend on): here, `isReadOnlyLocked` in
// api/projects/[id]/agent/tools.ts, and the top-level short-circuit in
// api/projects/[id]/agent/logic.ts's runAgentTurn. All three compute the boundary via
// stepIndex('storyboard') rather than a literal, and each has its own test that
// recomputes the same boundary the same way (tests/shot-deletion.spec.ts,
// tests/agent-turn.spec.ts) - so a future STEPS reorder moves every site and every
// test in lockstep. If you touch this line, check the other two stayed in sync.
export async function deleteShotForUser(
  supabase: SupabaseServerClient,
  shotId: string,
  userId: string
): Promise<ShotDeleteResult> {
  const { data: shot } = await supabase
    .from('shots')
    .select('id, project_id, projects!inner(user_id)')
    .eq('id', shotId)
    .eq('projects.user_id', userId)
    .maybeSingle()
  if (!shot) return { success: false, error: 'Shot not found' }

  const { data: project } = await supabase
    .from('projects')
    .select('furthest_step')
    .eq('id', shot.project_id)
    .single()
  if (project && project.furthest_step >= stepIndex('storyboard')) {
    return {
      success: false,
      error: "This project's workbench is locked - later steps have already started, so shots can no longer be deleted here.",
    }
  }

  const { error: deleteError } = await supabase.from('shots').delete().eq('id', shotId)
  if (deleteError) return { success: false, error: deleteError.message }

  // Keep order_index contiguous. Unlike shot_dialogue's order_index, shots has a real
  // shots_project_id_order_index_key UNIQUE(project_id, order_index) constraint (see
  // agent/tools.ts's handleInsertShot), so these updates run sequentially in ascending
  // order rather than via Promise.all - each target index is only vacated by the row
  // before it (or by the delete above), never before.
  const { data: remaining } = await supabase
    .from('shots')
    .select('id, order_index')
    .eq('project_id', shot.project_id)
    .order('order_index', { ascending: true })

  if (remaining) {
    for (const [index, row] of remaining.entries()) {
      if (row.order_index !== index) {
        await supabase.from('shots').update({ order_index: index }).eq('id', row.id)
      }
    }
  }

  // One continuous narration file per project - removing a shot changes what's actually
  // narrated, the same invalidation a voiceover text edit causes (see
  // stalenessFor('voice_over')). Non-fatal on failure, same as every other
  // project-level staleness write in this file: the delete itself already succeeded.
  const { error: projectError } = await supabase
    .from('projects')
    .update({ voiceover_stale: true })
    .eq('id', shot.project_id)
  if (projectError) {
    console.error(`[workbench] Failed to set voiceover_stale for project ${shot.project_id}:`, projectError.message)
  }

  return { success: true }
}

export async function deleteShot(shotId: string): Promise<ShotDeleteResult> {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return { success: false, error: 'Not authenticated' }

  return deleteShotForUser(supabase, shotId, user.id)
}

// Serves both the initial Assets-tab load and a client-driven refresh ahead of the
// signed URLs' one-hour expiry - re-running the same one-query-plus-one-batch-sign path
// is already cheap and correct, so there is no separate "refresh" function.
export async function getProjectElements(projectId: string): Promise<GetProjectElementsResult> {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return { success: false, error: 'Not authenticated' }

  return getProjectElementsForUser(supabase, projectId, user.id)
}

// Recovers one broken reference image without refetching the whole batch.
export async function resignElementReferenceImage(
  projectId: string,
  path: string
): Promise<ResignElementImageResult> {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return { success: false, error: 'Not authenticated' }

  return resignElementReferenceImageForUser(supabase, projectId, path, user.id)
}
