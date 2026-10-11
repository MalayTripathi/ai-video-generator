import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/lib/database.types'
import { stepIndex } from '@/lib/config/pipeline'
import { isDurationAllowed, isRegisteredVideoModel } from '@/lib/config/models'
import { parseQualitySettings, UnsupportedQualityError, type QualitySettings } from '@/lib/quality/estimate'
import { spokenSeconds, voiceCoveringDuration } from '@/lib/shots/durations'
import { effectiveVideoModel } from '@/lib/shots/effective-model'
import { parseSpans } from '@/lib/storyboard/voiceover'
import { hasLiveShotRun } from '@/lib/shots/runs'

// The project settings drawer's server side: which shots a new video model can't render at
// their saved length, and the one Apply that writes the five quality columns, gives those
// shots a length the model renders and marks video prompts stale. Saving settings is not
// advancing - nothing here touches current_step or furthest_step.

type Client = SupabaseClient<Database>

/**
 * One shot whose saved length the new model can't render, and the length it takes: the
 * renderable length nearest it that still covers its voice. `overflow`: none covers it -
 * it takes the model's longest and its speech will run past the clip. `number` is its card
 * number; the lengths shown are its film length (falling back to its script length).
 */
export type ShotLengthChange = {
  shotId: string
  number: number
  fromSeconds: number
  toSeconds: number
  hasDialogue: boolean
  overflow: boolean
}

export type ApplySettingsResult =
  | { ok: true; trimmed: number }
  | { ok: false; error: 'not_found' | 'unsupported' | 'locked' | 'write_failed'; message: string }
  // The over-length shots changed after the person confirmed - re-confirm with these.
  | { ok: false; error: 'trims_changed'; message: string; trims: ShotLengthChange[] }

const PROJECT_COLUMNS =
  'id, quality_preset, video_model, video_resolution, image_quality, image_model, furthest_step, language, voiceover_spans' as const

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

type ShotWrite = {
  id: string
  shot_key: string
  order_index: number
  duration_sec: number | null
  film_duration_sec: number | null
  narration_overflow: boolean
}

/**
 * Every shot (in the film or binned) whose script or film length the model can't render,
 * with its new lengths. Two reads - the shots, then their dialogue.
 */
async function findLengthChanges(
  supabase: Client,
  project: { id: string; language: string | null; voiceover_spans: unknown },
  videoModel: string
): Promise<{ changes: ShotLengthChange[]; writes: ShotWrite[] }> {
  const { data: shots, error } = await supabase
    .from('shots')
    .select('id, shot_key, order_index, voice_over, duration_sec, film_duration_sec')
    .eq('project_id', project.id)
    .order('order_index', { ascending: true })
  if (error) throw error
  const { data: lines, error: dialogueError } = await supabase
    .from('shot_dialogue')
    .select('shot_id, line')
    .eq('project_id', project.id)
  if (dialogueError) throw dialogueError
  const dialogueByShot = new Map<string, string[]>()
  for (const l of lines ?? []) dialogueByShot.set(l.shot_id, [...(dialogueByShot.get(l.shot_id) ?? []), l.line])
  // A read's measured speech, where there is one, is what a film length has to cover.
  const spokenByShot = new Map((parseSpans(project.voiceover_spans) ?? []).map((sp) => [sp.shotId, Math.max(0, sp.endSec - sp.startSec)]))

  const changes: ShotLengthChange[] = []
  const writes: ShotWrite[] = []
  for (const shot of shots ?? []) {
    const model = effectiveVideoModel({ video_model: videoModel }, shot)
    if (!model) continue
    const dialogue = dialogueByShot.get(shot.id) ?? []
    const words = spokenSeconds({ narration: shot.voice_over, dialogue, language: project.language })
    const fix = (seconds: number | null, voice: number) =>
      seconds === null || isDurationAllowed(model, seconds) ? { seconds, overflow: false } : voiceCoveringDuration(seconds, voice, model)
    const script = fix(shot.duration_sec, words)
    const film = fix(shot.film_duration_sec, spokenByShot.get(shot.id) ?? words)
    if (script.seconds === shot.duration_sec && film.seconds === shot.film_duration_sec) continue
    const overflow = script.overflow || film.overflow
    changes.push({
      shotId: shot.id,
      number: shot.order_index + 1,
      fromSeconds: shot.film_duration_sec ?? shot.duration_sec ?? 0,
      toSeconds: film.seconds ?? script.seconds ?? 0,
      hasDialogue: dialogue.length > 0,
      overflow,
    })
    writes.push({
      id: shot.id,
      shot_key: shot.shot_key,
      order_index: shot.order_index,
      duration_sec: script.seconds,
      film_duration_sec: film.seconds,
      narration_overflow: overflow,
    })
  }
  return { changes, writes }
}

/** The shots switching to `videoModel` would give a new length - their current and new lengths. */
export async function previewSettingsLengthChanges(
  supabase: Client,
  userId: string,
  projectId: string,
  videoModel: string
): Promise<ShotLengthChange[] | null> {
  if (!isRegisteredVideoModel(videoModel)) return null
  const project = await loadProject(supabase, userId, projectId)
  if (!project) return null
  if (project.video_model === videoModel) return []
  return (await findLengthChanges(supabase, project, videoModel)).changes
}

/**
 * Applies staged settings in one action: gives every shot the new model can't render at its
 * saved length a renderable one (both duration fields, one batched write), marks every
 * shot's video prompt stale when the model changed, then writes the five project columns.
 * `confirmedChangeCount` is how many length changes the person agreed to; if the server
 * finds a different set, nothing is written.
 */
export async function applyProjectSettings(
  supabase: Client,
  userId: string,
  projectId: string,
  raw: { preset: unknown; videoModel: unknown; videoResolution: unknown; imageQuality: unknown; imageModel: unknown },
  confirmedChangeCount: number
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

  // Not while a shot run is writing: its shots take the model it started with, and the
  // batched length write below must not land on a list the chain is still reshaping.
  if (modelChanged && (await hasLiveShotRun(supabase, projectId))) {
    return { ok: false, error: 'locked', message: 'The shot list is still being written. Change the video model once it has finished.' }
  }

  const { changes, writes } = modelChanged
    ? await findLengthChanges(supabase, project, settings.videoModel)
    : { changes: [], writes: [] }
  if (changes.length !== confirmedChangeCount) {
    return { ok: false, error: 'trims_changed', message: 'Some shots changed length. Review the list again.', trims: changes }
  }

  const now = new Date().toISOString()
  if (writes.length > 0) {
    // One upsert keyed on id: every changed shot's lengths land together or not at all.
    // Identity columns ride along unchanged (Postgres checks NOT NULL before the conflict).
    const { error } = await supabase.from('shots').upsert(
      writes.map((w) => ({ ...w, project_id: projectId, updated_at: now })),
      { onConflict: 'id', defaultToNull: false }
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

  return { ok: true, trimmed: changes.length }
}
