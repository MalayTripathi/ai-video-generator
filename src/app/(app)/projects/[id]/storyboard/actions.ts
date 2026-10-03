'use server'

import { createClient } from '@/lib/supabase/server'
import { MUSIC_STYLE_PROMPT_EDIT_MAX_CHARS } from '@/lib/config/storyboard'
import { filmDuration, filmSeconds, isRetimeAllowed, retimeBounds } from '@/lib/storyboard/timeline'
import type { Motion, Transition } from '@/lib/config/enums'
import { isSplitAllowed, parseMotion, parseTransition } from '@/lib/storyboard/motion'
import { isMixDbAllowed, MIX_COLUMNS, MIX_RANGES, type MixColumn } from '@/lib/storyboard/film'
import { EXPORT_SETTING_COLUMNS, EXPORT_SETTING_VALUES, type ExportSettingColumn } from '@/lib/export/settings'
import {
  fitToVoiceover as fitLengths,
  fitUnavailableReason,
  parseSpans,
  restoreSpanOrderWrites,
  voiceoverOrderDiffers,
  voiceoverStaleness,
} from '@/lib/storyboard/voiceover'

type SupabaseServerClient = Awaited<ReturnType<typeof createClient>>

// Storyboard timeline edits: retime, reorder, bin. Each is free, marks nothing stale, and
// writes only the Storyboard's own columns (film_order, film_duration_sec, binned_at) -
// never order_index or duration_sec, which belong to the script. Plain result objects,
// never thrown; ownership through the projects join, RLS as the backstop. Never calls
// advanceStep - saving is not advancing.
export type TimelineEditResult = { success: true; unchanged?: true } | { success: false; error: string }

type EditableProject = { id: string }

// The project, if this user owns it. The Storyboard never freezes: it stays editable after
// the project advances to Video Prompts.
async function editableProject(
  supabase: SupabaseServerClient,
  projectId: string,
  userId: string
): Promise<EditableProject | { error: string }> {
  const { data: project, error } = await supabase
    .from('projects')
    .select('id')
    .eq('id', projectId)
    .eq('user_id', userId)
    .maybeSingle()
  // A failed read is reported as a failed read, never as a missing project.
  if (error) return { error: 'Could not load project' }
  if (!project) return { error: 'Project not found' }
  return { id: project.id }
}

export async function saveFilmDurationForUser(
  supabase: SupabaseServerClient,
  userId: string,
  projectId: string,
  shotId: string,
  seconds: number
): Promise<TimelineEditResult> {
  const project = await editableProject(supabase, projectId, userId)
  if ('error' in project) return { success: false, error: project.error }

  const { data: shot } = await supabase
    .from('shots')
    .select('id, duration_sec, film_duration_sec, projects!inner(user_id)')
    .eq('id', shotId)
    .eq('project_id', projectId)
    .eq('projects.user_id', userId)
    .maybeSingle()
  if (!shot) return { success: false, error: 'Shot not found' }

  const committed = filmDuration(shot)
  if (!isRetimeAllowed(seconds, retimeBounds(committed))) return { success: false, error: 'That length is outside the allowed range' }
  if (seconds === committed) return { success: true, unchanged: true }

  const { error } = await supabase
    .from('shots')
    .update({ film_duration_sec: seconds, updated_at: new Date().toISOString() })
    .eq('id', shotId)
  if (error) return { success: false, error: error.message }
  return { success: true }
}

export async function saveFilmOrderForUser(
  supabase: SupabaseServerClient,
  userId: string,
  projectId: string,
  writes: { id: string; film_order: number }[]
): Promise<TimelineEditResult> {
  const project = await editableProject(supabase, projectId, userId)
  if ('error' in project) return { success: false, error: project.error }
  if (writes.length === 0) return { success: true, unchanged: true }
  if (!writes.every((w) => Number.isInteger(w.film_order) && w.film_order >= 0)) {
    return { success: false, error: 'Invalid order' }
  }

  const { data: shots } = await supabase
    .from('shots')
    .select('id, film_order')
    .eq('project_id', projectId)
    .in(
      'id',
      writes.map((w) => w.id)
    )
  if (!shots || shots.length !== new Set(writes.map((w) => w.id)).size) return { success: false, error: 'Shot not found' }

  const current = new Map(shots.map((s) => [s.id, s.film_order]))
  const updatedAt = new Date().toISOString()
  // A plain per-row loop - no RPC. Each write is independent; last write wins.
  for (const w of writes) {
    if (current.get(w.id) === w.film_order) continue
    const { error } = await supabase
      .from('shots')
      .update({ film_order: w.film_order, updated_at: updatedAt })
      .eq('id', w.id)
      .eq('project_id', projectId)
    if (error) return { success: false, error: error.message }
  }
  return { success: true }
}

export async function restoreScriptOrderForUser(
  supabase: SupabaseServerClient,
  userId: string,
  projectId: string
): Promise<TimelineEditResult> {
  const project = await editableProject(supabase, projectId, userId)
  if ('error' in project) return { success: false, error: project.error }

  // With a voiceover, "script order" is the order it was read in: the read's shots go back
  // to that order inside the slots they hold now. Without one, the Storyboard's own order
  // is simply cleared back to the script's.
  const { data: vo } = await supabase.from('projects').select('voiceover_spans').eq('id', projectId).maybeSingle()
  const spans = parseSpans(vo?.voiceover_spans ?? null)
  if (spans) {
    const { data: shots, error: shotsError } = await supabase
      .from('shots')
      .select('id, voice_over, order_index, film_order, binned_at')
      .eq('project_id', projectId)
    if (shotsError) return { success: false, error: shotsError.message }
    const writes = restoreSpanOrderWrites(spans, shots ?? [])
    if (writes.length === 0) return { success: true, unchanged: true }
    const updatedAt = new Date().toISOString()
    for (const w of writes) {
      const { error } = await supabase
        .from('shots')
        .update({ film_order: w.film_order, updated_at: updatedAt })
        .eq('id', w.id)
        .eq('project_id', projectId)
      if (error) return { success: false, error: error.message }
    }
    return { success: true }
  }

  const { error } = await supabase
    .from('shots')
    .update({ film_order: null, updated_at: new Date().toISOString() })
    .eq('project_id', projectId)
    .not('film_order', 'is', null)
  if (error) return { success: false, error: error.message }
  return { success: true }
}

// Voiceover edits (Storyboard C1). Free; plain result objects like every edit above.

export type FitResultAction =
  | { success: true; lengths: { id: string; seconds: number }[]; clamped: string[] }
  | { success: false; error: string }

/**
 * Fit to voiceover: recomputed here from the stored spans and the shots as they stand -
 * never from lengths the page sends - and refused with the same reasons the button shows.
 * Writes film_duration_sec only, for each in-film shot whose length changes.
 */
export async function fitToVoiceoverForUser(
  supabase: SupabaseServerClient,
  userId: string,
  projectId: string
): Promise<FitResultAction> {
  const project = await editableProject(supabase, projectId, userId)
  if ('error' in project) return { success: false, error: project.error }

  const { data: vo } = await supabase
    .from('projects')
    .select('audio_path, voiceover_spans, total_duration_sec')
    .eq('id', projectId)
    .maybeSingle()
  const spans = parseSpans(vo?.voiceover_spans ?? null)
  const { data: shots, error: shotsError } = await supabase
    .from('shots')
    .select('id, voice_over, order_index, film_order, binned_at, duration_sec, film_duration_sec')
    .eq('project_id', projectId)
  if (shotsError) return { success: false, error: shotsError.message }

  const hasVoiceover = !!vo?.audio_path && spans !== null
  const reason = fitUnavailableReason({
    hasVoiceover,
    inFlight: false,
    stale: hasVoiceover && voiceoverStaleness(spans!, shots ?? []).stale,
    orderDiffers: hasVoiceover && voiceoverOrderDiffers(spans!, shots ?? []),
  })
  if (reason) return { success: false, error: reason }

  const result = fitLengths(spans!, shots ?? [], vo!.total_duration_sec ?? 0)
  const updatedAt = new Date().toISOString()
  for (const w of result.writes) {
    const { error } = await supabase
      .from('shots')
      .update({ film_duration_sec: w.film_duration_sec, updated_at: updatedAt })
      .eq('id', w.id)
      .eq('project_id', projectId)
    if (error) return { success: false, error: error.message }
  }
  return { success: true, lengths: result.lengths, clamped: result.clamped }
}

// The project's current-voiceover columns, nulled. The files stay in storage - Remove
// discards nothing that was paid for.
export async function removeVoiceoverForUser(
  supabase: SupabaseServerClient,
  userId: string,
  projectId: string
): Promise<TimelineEditResult> {
  const project = await editableProject(supabase, projectId, userId)
  if ('error' in project) return { success: false, error: project.error }
  const { error } = await supabase
    .from('projects')
    .update({
      audio_path: null,
      voiceover_alignment_path: null,
      voice_id: null,
      language_code: null,
      tts_model: null,
      total_duration_sec: null,
      voiceover_source: null,
      voiceover_generated_at: null,
      voiceover_spans: null,
      voiceover_words: null,
      updated_at: new Date().toISOString(),
    })
    .eq('id', projectId)
  if (error) return { success: false, error: error.message }
  return { success: true }
}

export async function setVoiceoverMutedForUser(
  supabase: SupabaseServerClient,
  userId: string,
  projectId: string,
  muted: boolean
): Promise<TimelineEditResult> {
  const project = await editableProject(supabase, projectId, userId)
  if ('error' in project) return { success: false, error: project.error }
  const { error } = await supabase
    .from('projects')
    .update({ voiceover_muted: muted, updated_at: new Date().toISOString() })
    .eq('id', projectId)
  if (error) return { success: false, error: error.message }
  return { success: true }
}

// Music (Storyboard D). All free: each diffs against the stored value first, and an edit
// that changes nothing writes nothing.

type MusicRow = {
  music_path: string | null
  music_style_prompt: string | null
  music_loop: boolean
  music_muted: boolean | null
}

// The project's music columns, or why they can't be read - a failed read is reported as
// such, never as a missing project.
async function musicRow(supabase: SupabaseServerClient, projectId: string): Promise<MusicRow | { error: string }> {
  const { data, error } = await supabase
    .from('projects')
    .select('music_path, music_style_prompt, music_loop, music_muted')
    .eq('id', projectId)
    .maybeSingle()
  if (error) return { error: 'Could not load project' }
  return data ?? { error: 'Project not found' }
}

/** The style prompt, saved on blur. Empty saves as null, so the placeholder shows again. */
export async function saveMusicStylePromptForUser(
  supabase: SupabaseServerClient,
  userId: string,
  projectId: string,
  prompt: string
): Promise<TimelineEditResult> {
  const project = await editableProject(supabase, projectId, userId)
  if ('error' in project) return { success: false, error: project.error }
  const next = prompt.replace(/\s+/g, ' ').trim()
  if (next.length > MUSIC_STYLE_PROMPT_EDIT_MAX_CHARS) return { success: false, error: 'That style prompt is too long' }
  const row = await musicRow(supabase, projectId)
  if ('error' in row) return { success: false, error: row.error }
  const value = next === '' ? null : next
  if ((row.music_style_prompt ?? null) === value) return { success: true, unchanged: true }
  const { error } = await supabase
    .from('projects')
    .update({ music_style_prompt: value, updated_at: new Date().toISOString() })
    .eq('id', projectId)
  if (error) return { success: false, error: error.message }
  return { success: true }
}

export async function setMusicMutedForUser(
  supabase: SupabaseServerClient,
  userId: string,
  projectId: string,
  muted: boolean
): Promise<TimelineEditResult> {
  const project = await editableProject(supabase, projectId, userId)
  if ('error' in project) return { success: false, error: project.error }
  const row = await musicRow(supabase, projectId)
  if ('error' in row) return { success: false, error: row.error }
  if ((row.music_muted ?? false) === muted) return { success: true, unchanged: true }
  const { error } = await supabase
    .from('projects')
    .update({ music_muted: muted, updated_at: new Date().toISOString() })
    .eq('id', projectId)
  if (error) return { success: false, error: error.message }
  return { success: true }
}

/** Loop to fit (free): the film loops the music with a crossfade until the picture ends. */
export async function setMusicLoopForUser(
  supabase: SupabaseServerClient,
  userId: string,
  projectId: string,
  loop: boolean
): Promise<TimelineEditResult> {
  const project = await editableProject(supabase, projectId, userId)
  if ('error' in project) return { success: false, error: project.error }
  const row = await musicRow(supabase, projectId)
  if ('error' in row) return { success: false, error: row.error }
  if (!row.music_path) return { success: false, error: 'There is no music to loop' }
  if (row.music_loop === loop) return { success: true, unchanged: true }
  const { error } = await supabase
    .from('projects')
    .update({ music_loop: loop, updated_at: new Date().toISOString() })
    .eq('id', projectId)
  if (error) return { success: false, error: error.message }
  return { success: true }
}

/** Remove nulls the current-music columns. The file stays in storage; the style prompt is kept. */
export async function removeMusicForUser(
  supabase: SupabaseServerClient,
  userId: string,
  projectId: string
): Promise<TimelineEditResult> {
  const project = await editableProject(supabase, projectId, userId)
  if ('error' in project) return { success: false, error: project.error }
  const row = await musicRow(supabase, projectId)
  if ('error' in row) return { success: false, error: row.error }
  if (!row.music_path) return { success: true, unchanged: true }
  const { error } = await supabase
    .from('projects')
    .update({
      music_path: null,
      music_duration_sec: null,
      music_source: null,
      music_generated_at: null,
      music_loop: false,
      updated_at: new Date().toISOString(),
    })
    .eq('id', projectId)
  if (error) return { success: false, error: error.message }
  return { success: true }
}

// Remove sets binned_at; Restore clears it. The image and film_order are kept, so a
// restored shot returns to the slot it left.
export async function setShotBinnedForUser(
  supabase: SupabaseServerClient,
  userId: string,
  projectId: string,
  shotId: string,
  binned: boolean
): Promise<TimelineEditResult & { binnedAt?: string | null }> {
  const project = await editableProject(supabase, projectId, userId)
  if ('error' in project) return { success: false, error: project.error }

  const { data: shot } = await supabase
    .from('shots')
    .select('id, binned_at')
    .eq('id', shotId)
    .eq('project_id', projectId)
    .maybeSingle()
  if (!shot) return { success: false, error: 'Shot not found' }
  if ((shot.binned_at !== null) === binned) return { success: true, unchanged: true, binnedAt: shot.binned_at }

  const now = new Date().toISOString()
  const binnedAt = binned ? now : null
  const { error } = await supabase.from('shots').update({ binned_at: binnedAt, updated_at: now }).eq('id', shotId)
  if (error) return { success: false, error: error.message }
  return { success: true, binnedAt }
}

// Motion & transitions (Storyboard B3). Render-only and free: each writes one shot's own
// motion / split / transition_out columns, marks nothing stale, and diffs first.

export type MotionSegment = 'a' | 'b'

/** A shot's motion (segment a) or its split's second-segment motion (b). Null follows the film default. */
export async function saveShotMotionForUser(
  supabase: SupabaseServerClient,
  userId: string,
  projectId: string,
  shotId: string,
  segment: MotionSegment,
  motion: Motion | null
): Promise<TimelineEditResult> {
  const project = await editableProject(supabase, projectId, userId)
  if ('error' in project) return { success: false, error: project.error }
  if (segment !== 'a' && segment !== 'b') return { success: false, error: 'Invalid segment' }
  if (motion !== null && parseMotion(motion) === null) return { success: false, error: 'Invalid motion' }

  const { data: shot } = await supabase
    .from('shots')
    .select('id, motion, split_at, split_motion')
    .eq('id', shotId)
    .eq('project_id', projectId)
    .maybeSingle()
  if (!shot) return { success: false, error: 'Shot not found' }
  if (segment === 'b' && shot.split_at === null) return { success: false, error: 'This shot is not split' }

  const column = segment === 'a' ? 'motion' : 'split_motion'
  if (shot[column] === motion) return { success: true, unchanged: true }
  const { error } = await supabase
    .from('shots')
    .update({ [column]: motion, updated_at: new Date().toISOString() })
    .eq('id', shotId)
  if (error) return { success: false, error: error.message }
  return { success: true }
}

/**
 * Sets a shot's one split, as a fraction of its current length - each segment at least the
 * minimum shot length. Null deletes the split, clearing its second-segment motion with it.
 */
export async function saveShotSplitForUser(
  supabase: SupabaseServerClient,
  userId: string,
  projectId: string,
  shotId: string,
  splitAt: number | null
): Promise<TimelineEditResult> {
  const project = await editableProject(supabase, projectId, userId)
  if ('error' in project) return { success: false, error: project.error }

  const { data: shot } = await supabase
    .from('shots')
    .select('id, duration_sec, film_duration_sec, split_at, split_motion')
    .eq('id', shotId)
    .eq('project_id', projectId)
    .maybeSingle()
  if (!shot) return { success: false, error: 'Shot not found' }

  const updatedAt = new Date().toISOString()
  if (splitAt === null) {
    if (shot.split_at === null && shot.split_motion === null) return { success: true, unchanged: true }
    const { error } = await supabase
      .from('shots')
      .update({ split_at: null, split_motion: null, updated_at: updatedAt })
      .eq('id', shotId)
    if (error) return { success: false, error: error.message }
    return { success: true }
  }

  if (typeof splitAt !== 'number' || !isSplitAllowed(splitAt, filmSeconds(shot))) {
    return { success: false, error: 'That split is outside what this shot allows' }
  }
  if (shot.split_at === splitAt) return { success: true, unchanged: true }
  const { error } = await supabase.from('shots').update({ split_at: splitAt, updated_at: updatedAt }).eq('id', shotId)
  if (error) return { success: false, error: error.message }
  return { success: true }
}

/** The join after this shot. Null follows the film default. */
export async function saveTransitionForUser(
  supabase: SupabaseServerClient,
  userId: string,
  projectId: string,
  shotId: string,
  transition: Transition | null
): Promise<TimelineEditResult> {
  const project = await editableProject(supabase, projectId, userId)
  if ('error' in project) return { success: false, error: project.error }
  if (transition !== null && parseTransition(transition) === null) return { success: false, error: 'Invalid transition' }

  const { data: shot } = await supabase
    .from('shots')
    .select('id, transition_out')
    .eq('id', shotId)
    .eq('project_id', projectId)
    .maybeSingle()
  if (!shot) return { success: false, error: 'Shot not found' }
  if (shot.transition_out === transition) return { success: true, unchanged: true }
  const { error } = await supabase
    .from('shots')
    .update({ transition_out: transition, updated_at: new Date().toISOString() })
    .eq('id', shotId)
  if (error) return { success: false, error: error.message }
  return { success: true }
}

// Preview & mix (E). One field per save, field-attributed; null returns a field to its
// default. Free, and marks nothing stale. A value equal to the stored one writes nothing.
export type MixValue = number | boolean | null
export type MixSaveResult = ({ success: true; unchanged?: true } | { success: false; error: string }) & { field: MixColumn | 'all' }

function isMixValueAllowed(field: MixColumn, value: MixValue): boolean {
  if (value === null) return true
  if (field === 'mix_duck_bypass') return typeof value === 'boolean'
  return typeof value === 'number' && isMixDbAllowed(value, MIX_RANGES[field])
}

export async function saveMixForUser(
  supabase: SupabaseServerClient,
  userId: string,
  projectId: string,
  field: MixColumn,
  value: MixValue
): Promise<MixSaveResult> {
  if (!(MIX_COLUMNS as readonly string[]).includes(field)) return { success: false, error: 'Unknown mix setting', field }
  if (!isMixValueAllowed(field, value)) return { success: false, error: 'That value is out of range', field }
  const project = await editableProject(supabase, projectId, userId)
  if ('error' in project) return { success: false, error: project.error, field }
  const { data: current } = await supabase.from('projects').select(field).eq('id', projectId).maybeSingle()
  if (current && (current as Record<string, unknown>)[field] === value) return { success: true, unchanged: true, field }
  const { error } = await supabase
    .from('projects')
    .update({ [field]: value, updated_at: new Date().toISOString() })
    .eq('id', projectId)
  if (error) return { success: false, error: error.message, field }
  return { success: true, field }
}

// Export settings (F). One field per save, field-attributed; null returns a field to its
// default. The motion and transition settings are the film defaults, so they change what
// every shot without its own choice plays. Free, and marks nothing stale.
export type ExportSettingSaveResult = ({ success: true; unchanged?: true } | { success: false; error: string }) & {
  field: ExportSettingColumn
}

export async function saveExportSettingForUser(
  supabase: SupabaseServerClient,
  userId: string,
  projectId: string,
  field: ExportSettingColumn,
  value: string | null
): Promise<ExportSettingSaveResult> {
  if (!(EXPORT_SETTING_COLUMNS as readonly string[]).includes(field)) {
    return { success: false, error: 'Unknown export setting', field }
  }
  if (value !== null && !EXPORT_SETTING_VALUES[field].includes(value)) {
    return { success: false, error: 'That value is not allowed', field }
  }
  const project = await editableProject(supabase, projectId, userId)
  if ('error' in project) return { success: false, error: project.error, field }
  const { data: current } = await supabase.from('projects').select(field).eq('id', projectId).maybeSingle()
  if (current && (current as Record<string, unknown>)[field] === value) return { success: true, unchanged: true, field }
  const { error } = await supabase
    .from('projects')
    .update({ [field]: value, updated_at: new Date().toISOString() })
    .eq('id', projectId)
  if (error) return { success: false, error: error.message, field }
  return { success: true, field }
}

// Reset mix: every mix setting back to its default (null). Lane mutes are lane state and stay.
export async function resetMixForUser(supabase: SupabaseServerClient, userId: string, projectId: string): Promise<MixSaveResult> {
  const project = await editableProject(supabase, projectId, userId)
  if ('error' in project) return { success: false, error: project.error, field: 'all' }
  const { error } = await supabase
    .from('projects')
    .update({
      mix_voice_gain_db: null,
      mix_music_gain_db: null,
      mix_duck_depth_db: null,
      mix_duck_bypass: null,
      updated_at: new Date().toISOString(),
    })
    .eq('id', projectId)
  if (error) return { success: false, error: error.message, field: 'all' }
  return { success: true, field: 'all' }
}

async function currentUser() {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  return { supabase, user }
}

const NOT_AUTHENTICATED = { success: false, error: 'Not authenticated' } as const

export async function saveFilmDuration(projectId: string, shotId: string, seconds: number): Promise<TimelineEditResult> {
  const { supabase, user } = await currentUser()
  if (!user) return NOT_AUTHENTICATED
  return saveFilmDurationForUser(supabase, user.id, projectId, shotId, seconds)
}

export async function saveFilmOrder(
  projectId: string,
  writes: { id: string; film_order: number }[]
): Promise<TimelineEditResult> {
  const { supabase, user } = await currentUser()
  if (!user) return NOT_AUTHENTICATED
  return saveFilmOrderForUser(supabase, user.id, projectId, writes)
}

export async function restoreScriptOrder(projectId: string): Promise<TimelineEditResult> {
  const { supabase, user } = await currentUser()
  if (!user) return NOT_AUTHENTICATED
  return restoreScriptOrderForUser(supabase, user.id, projectId)
}

export async function setShotBinned(
  projectId: string,
  shotId: string,
  binned: boolean
): Promise<TimelineEditResult & { binnedAt?: string | null }> {
  const { supabase, user } = await currentUser()
  if (!user) return NOT_AUTHENTICATED
  return setShotBinnedForUser(supabase, user.id, projectId, shotId, binned)
}

export async function fitToVoiceover(projectId: string): Promise<FitResultAction> {
  const { supabase, user } = await currentUser()
  if (!user) return NOT_AUTHENTICATED
  return fitToVoiceoverForUser(supabase, user.id, projectId)
}

export async function removeVoiceover(projectId: string): Promise<TimelineEditResult> {
  const { supabase, user } = await currentUser()
  if (!user) return NOT_AUTHENTICATED
  return removeVoiceoverForUser(supabase, user.id, projectId)
}

export async function setVoiceoverMuted(projectId: string, muted: boolean): Promise<TimelineEditResult> {
  const { supabase, user } = await currentUser()
  if (!user) return NOT_AUTHENTICATED
  return setVoiceoverMutedForUser(supabase, user.id, projectId, muted)
}

export async function saveMusicStylePrompt(projectId: string, prompt: string): Promise<TimelineEditResult> {
  const { supabase, user } = await currentUser()
  if (!user) return NOT_AUTHENTICATED
  return saveMusicStylePromptForUser(supabase, user.id, projectId, prompt)
}

export async function setMusicMuted(projectId: string, muted: boolean): Promise<TimelineEditResult> {
  const { supabase, user } = await currentUser()
  if (!user) return NOT_AUTHENTICATED
  return setMusicMutedForUser(supabase, user.id, projectId, muted)
}

export async function setMusicLoop(projectId: string, loop: boolean): Promise<TimelineEditResult> {
  const { supabase, user } = await currentUser()
  if (!user) return NOT_AUTHENTICATED
  return setMusicLoopForUser(supabase, user.id, projectId, loop)
}

export async function removeMusic(projectId: string): Promise<TimelineEditResult> {
  const { supabase, user } = await currentUser()
  if (!user) return NOT_AUTHENTICATED
  return removeMusicForUser(supabase, user.id, projectId)
}

export async function saveShotMotion(
  projectId: string,
  shotId: string,
  segment: MotionSegment,
  motion: Motion | null
): Promise<TimelineEditResult> {
  const { supabase, user } = await currentUser()
  if (!user) return NOT_AUTHENTICATED
  return saveShotMotionForUser(supabase, user.id, projectId, shotId, segment, motion)
}

export async function saveShotSplit(projectId: string, shotId: string, splitAt: number | null): Promise<TimelineEditResult> {
  const { supabase, user } = await currentUser()
  if (!user) return NOT_AUTHENTICATED
  return saveShotSplitForUser(supabase, user.id, projectId, shotId, splitAt)
}

export async function saveTransition(
  projectId: string,
  shotId: string,
  transition: Transition | null
): Promise<TimelineEditResult> {
  const { supabase, user } = await currentUser()
  if (!user) return NOT_AUTHENTICATED
  return saveTransitionForUser(supabase, user.id, projectId, shotId, transition)
}

export async function saveMix(projectId: string, field: MixColumn, value: MixValue): Promise<MixSaveResult> {
  const { supabase, user } = await currentUser()
  if (!user) return { ...NOT_AUTHENTICATED, field }
  return saveMixForUser(supabase, user.id, projectId, field, value)
}

export async function resetMix(projectId: string): Promise<MixSaveResult> {
  const { supabase, user } = await currentUser()
  if (!user) return { ...NOT_AUTHENTICATED, field: 'all' }
  return resetMixForUser(supabase, user.id, projectId)
}

export async function saveExportSetting(
  projectId: string,
  field: ExportSettingColumn,
  value: string | null
): Promise<ExportSettingSaveResult> {
  const { supabase, user } = await currentUser()
  if (!user) return { ...NOT_AUTHENTICATED, field }
  return saveExportSettingForUser(supabase, user.id, projectId, field, value)
}
