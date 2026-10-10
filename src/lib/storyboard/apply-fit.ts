import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/lib/database.types'
import { resolveVideoModel, type VideoModelConfig } from '@/lib/config/models'
import { fitToVoiceover, fitUnavailableReason, parseSpans, voiceoverOrderDiffers, voiceoverStaleness } from './voiceover'

type Client = SupabaseClient<Database>

export type ApplyFitResult =
  | { success: true; lengths: { id: string; seconds: number }[]; clamped: string[] }
  | { success: false; error: string }

function safeModel(id: string | null): VideoModelConfig | null {
  try {
    return resolveVideoModel(id)
  } catch {
    return null
  }
}

/**
 * Fit to voiceover, server side: recomputed from the stored spans and the shots as they
 * stand - never from lengths a page sends - and refused with the same reasons the button
 * shows. Writes film_duration_sec for each in-film shot whose length changes, and stamps
 * last_fit_at. Free. The caller has already checked the project is the user's and
 * editable (the button) or is a worker acting for its owner (auto-fit).
 */
export async function applyFitToVoiceover(supabase: Client, projectId: string): Promise<ApplyFitResult> {
  const [{ data: vo }, { data: shots, error: shotsError }] = await Promise.all([
    supabase.from('projects').select('audio_path, voiceover_spans, video_model').eq('id', projectId).maybeSingle(),
    supabase
      .from('shots')
      .select('id, voice_over, order_index, film_order, binned_at, duration_sec, film_duration_sec')
      .eq('project_id', projectId),
  ])
  if (shotsError) return { success: false, error: shotsError.message }

  const spans = parseSpans(vo?.voiceover_spans ?? null)
  const hasVoiceover = !!vo?.audio_path && spans !== null
  const reason = fitUnavailableReason({
    hasVoiceover,
    inFlight: false,
    stale: hasVoiceover && voiceoverStaleness(spans!, shots ?? []).stale,
    orderDiffers: hasVoiceover && voiceoverOrderDiffers(spans!, shots ?? []),
  })
  if (reason) return { success: false, error: reason }
  const model = safeModel(vo?.video_model ?? null)
  if (!model) return { success: false, error: "This project's video model isn't available, so shot lengths can't be set." }

  const result = fitToVoiceover(spans!, shots ?? [], model)
  const updatedAt = new Date().toISOString()
  for (const w of result.writes) {
    const { error } = await supabase
      .from('shots')
      .update({ film_duration_sec: w.film_duration_sec, updated_at: updatedAt })
      .eq('id', w.id)
      .eq('project_id', projectId)
    if (error) return { success: false, error: error.message }
  }
  const { error: stampError } = await supabase
    .from('projects')
    .update({ last_fit_at: updatedAt, updated_at: updatedAt })
    .eq('id', projectId)
  if (stampError) return { success: false, error: stampError.message }
  return { success: true, lengths: result.lengths, clamped: result.clamped }
}

/**
 * Runs once a new read's alignment is saved. The first read is always fitted, free. A
 * later one is refitted silently unless a person retimed shots by hand after the last fit -
 * then it is left for the Storyboard's "Refit timing?" question (isRefitPending). Never
 * throws: a fit that can't run (e.g. picture order differs) leaves the lengths as they were.
 */
export async function autoFitAfterVoiceover(supabase: Client, projectId: string): Promise<void> {
  try {
    const { data } = await supabase.from('projects').select('last_fit_at, last_manual_retime_at').eq('id', projectId).maybeSingle()
    const fit = data?.last_fit_at ? Date.parse(data.last_fit_at) : null
    const manual = data?.last_manual_retime_at ? Date.parse(data.last_manual_retime_at) : null
    if (fit !== null && manual !== null && manual > fit) return
    const result = await applyFitToVoiceover(supabase, projectId)
    if (!result.success) console.warn(`[voiceover] auto-fit skipped for project ${projectId}: ${result.error}`)
  } catch (err) {
    console.error(`[voiceover] auto-fit failed for project ${projectId}`, err)
  }
}
