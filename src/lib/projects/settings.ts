import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/lib/database.types'
import { stepIndex } from '@/lib/config/pipeline'
import { isRegisteredVideoModel, type VideoModelId } from '@/lib/config/models'
import { maxShotSeconds, parseQualitySettings, UnsupportedQualityError, type QualitySettings } from '@/lib/quality/estimate'

// The project settings drawer's server side: which shots a lower maximum would trim, and
// the one Apply that writes the five quality columns, trims those shots and marks video
// prompts stale. Saving settings is not advancing - nothing here touches current_step or
// furthest_step.

type Client = SupabaseClient<Database>

/** One in-film shot longer than the new model's maximum. `number` is its card number. */
export type ShotTrim = { shotId: string; number: number; fromSeconds: number; toSeconds: number; hasDialogue: boolean }

export type ApplySettingsResult =
  | { ok: true; trimmed: number }
  | { ok: false; error: 'not_found' | 'unsupported' | 'locked' | 'write_failed'; message: string }
  // The over-length shots changed after the person confirmed - re-confirm with these.
  | { ok: false; error: 'trims_changed'; message: string; trims: ShotTrim[] }

const PROJECT_COLUMNS = 'id, quality_preset, video_model, video_resolution, image_quality, image_model, furthest_step' as const

/** Video settings lock once the project has reached clip generation; image settings never do. */
export function isVideoSettingsLocked(furthestStep: number): boolean {
  return furthestStep >= stepIndex('generation')
}

async function loadProject(supabase: Client, userId: string, projectId: string) {
  const { data, error } = await supabase
    .from('projects')
    .select(PROJECT_COLUMNS)
    .eq('id', projectId)
    .eq('user_id', userId)
    .maybeSingle()
  if (error) throw error
  return data
}

// Whether moving from `from` to `to` lowers the longest shot a project can hold. An
// unregistered stored model has no known maximum, so any registered one is treated as lower.
function maximumDecreases(from: string | null, to: VideoModelId): boolean {
  if (!isRegisteredVideoModel(from)) return true
  return maxShotSeconds(to) < maxShotSeconds(from)
}

// In-film shots over `maxSeconds` (film length, falling back to the shot's own duration),
// with whether each has any dialogue. Two reads, run only when the maximum decreases.
async function findTrims(supabase: Client, projectId: string, maxSeconds: number): Promise<ShotTrim[]> {
  const { data: shots, error } = await supabase
    .from('shots')
    .select('id, order_index, duration_sec, film_duration_sec')
    .eq('project_id', projectId)
    .is('binned_at', null)
    .order('order_index', { ascending: true })
  if (error) throw error
  const over = (shots ?? []).flatMap((shot) => {
    const seconds = shot.film_duration_sec ?? shot.duration_sec
    return seconds !== null && seconds > maxSeconds ? [{ shot, seconds }] : []
  })
  if (over.length === 0) return []

  const { data: lines, error: dialogueError } = await supabase
    .from('shot_dialogue')
    .select('shot_id')
    .in(
      'shot_id',
      over.map(({ shot }) => shot.id)
    )
  if (dialogueError) throw dialogueError
  const withDialogue = new Set((lines ?? []).map((line) => line.shot_id))

  return over.map(({ shot, seconds }) => ({
    shotId: shot.id,
    number: shot.order_index + 1,
    fromSeconds: seconds,
    toSeconds: maxSeconds,
    hasDialogue: withDialogue.has(shot.id),
  }))
}

/** The shots switching to `videoModel` would trim - empty, with no shot read, unless the maximum decreases. */
export async function previewSettingsTrims(
  supabase: Client,
  userId: string,
  projectId: string,
  videoModel: string
): Promise<ShotTrim[] | null> {
  if (!isRegisteredVideoModel(videoModel)) return null
  const project = await loadProject(supabase, userId, projectId)
  if (!project) return null
  if (!maximumDecreases(project.video_model, videoModel)) return []
  return findTrims(supabase, projectId, maxShotSeconds(videoModel))
}

/**
 * Applies staged settings in one action: trims the in-film shots over a lower maximum
 * (both duration fields), marks every shot's video prompt stale when the model changed,
 * then writes the five project columns. `confirmedTrimCount` is how many trims the person
 * agreed to; if the server finds a different set, nothing is written.
 */
export async function applyProjectSettings(
  supabase: Client,
  userId: string,
  projectId: string,
  raw: { preset: unknown; videoModel: unknown; videoResolution: unknown; imageQuality: unknown; imageModel: unknown },
  confirmedTrimCount: number
): Promise<ApplySettingsResult> {
  let settings: QualitySettings
  try {
    settings = parseQualitySettings(raw)
  } catch (error) {
    if (error instanceof UnsupportedQualityError) return { ok: false, error: 'unsupported', message: error.message }
    throw error
  }

  const project = await loadProject(supabase, userId, projectId)
  if (!project) return { ok: false, error: 'not_found', message: 'Project not found.' }

  const modelChanged = settings.videoModel !== project.video_model
  const resolutionChanged = settings.videoResolution !== project.video_resolution
  const presetChanged = settings.preset !== project.quality_preset
  const imageChanged = settings.imageQuality !== project.image_quality || settings.imageModel !== project.image_model
  if (!modelChanged && !resolutionChanged && !presetChanged && !imageChanged) return { ok: true, trimmed: 0 }

  // Image model and quality stay editable after the lock, and changing either makes the
  // preset 'custom' - so a move to 'custom' is the one preset change the lock allows.
  // Nothing already drawn is regenerated: the new model applies to new images only.
  if (
    isVideoSettingsLocked(project.furthest_step) &&
    (modelChanged || resolutionChanged || (presetChanged && settings.preset !== 'custom'))
  ) {
    return { ok: false, error: 'locked', message: 'Video settings are locked after generation starts.' }
  }

  const trims =
    modelChanged && maximumDecreases(project.video_model, settings.videoModel)
      ? await findTrims(supabase, projectId, maxShotSeconds(settings.videoModel))
      : []
  if (trims.length !== confirmedTrimCount) {
    return { ok: false, error: 'trims_changed', message: 'Some shots changed length. Review the list again.', trims }
  }

  const now = new Date().toISOString()
  if (trims.length > 0) {
    const max = maxShotSeconds(settings.videoModel)
    const { error } = await supabase
      .from('shots')
      .update({ duration_sec: max, film_duration_sec: max, updated_at: now })
      .eq('project_id', projectId)
      .in(
        'id',
        trims.map((trim) => trim.shotId)
      )
    if (error) return { ok: false, error: 'write_failed', message: error.message }
  }

  if (modelChanged) {
    const { error } = await supabase
      .from('shots')
      .update({ video_prompt_stale: true, updated_at: now })
      .eq('project_id', projectId)
    if (error) return { ok: false, error: 'write_failed', message: error.message }
  }

  // Last, so a failure above leaves the saved settings as they were and Apply can be retried.
  const { error } = await supabase
    .from('projects')
    .update({
      quality_preset: settings.preset,
      video_model: settings.videoModel,
      video_resolution: settings.videoResolution,
      image_quality: settings.imageQuality,
      image_model: settings.imageModel,
      updated_at: now,
    })
    .eq('id', projectId)
    .eq('user_id', userId)
  if (error) return { ok: false, error: 'write_failed', message: error.message }

  return { ok: true, trimmed: trims.length }
}
