'use server'

import { createClient } from '@/lib/supabase/server'
import { SHOT_SIZES, CAMERA_ANGLES, CAMERA_MOVEMENTS } from '@/lib/config/enums'

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
  | { field: ShotField; success: false; error: string }

export type DialogueSaveResult =
  | { success: true; id: string; unchanged?: true }
  | { success: false; error: string }

export type DialogueDeleteResult = { success: true } | { success: false; error: string }

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
  if (trimmed === shot.voice_over) return { field, success: true, unchanged: true }

  const { error } = await supabase
    .from('shots')
    .update({ voice_over: trimmed, image_prompt_stale: true, video_prompt_stale: true })
    .eq('id', shotId)
  if (error) return { field, success: false, error: error.message }

  // Separate table, separate call - no cross-table transaction is available without an
  // RPC (banned in this repo). The shots write above is the primary artifact and has
  // already succeeded; a failure here is logged but doesn't turn the field save into a
  // failure the user has to retry - the text itself is safely persisted either way.
  const { error: projectError } = await supabase
    .from('projects')
    .update({ voiceover_stale: true })
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
  const persisted = shot.visual_description ?? ''
  if (trimmed === persisted) return { field, success: true, unchanged: true }

  const { error } = await supabase
    .from('shots')
    .update({ visual_description: trimmed, image_prompt_stale: true, video_prompt_stale: true })
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
    .update({ [field]: value, [originColumn]: 'override', image_prompt_stale: true, video_prompt_stale: true })
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
  const { error } = await supabase.from('shots').update({ video_prompt_stale: true }).eq('id', shotId)
  if (error) {
    console.error(`[workbench] Failed to set video_prompt_stale for shot ${shotId}:`, error.message)
  }
}
