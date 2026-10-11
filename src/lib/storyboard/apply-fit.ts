import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/lib/database.types'
import { effectiveVideoModel } from '@/lib/shots/effective-model'
import {
  fitToVoiceover,
  fitUnavailableReason,
  parseSpans,
  voiceoverOrderDiffers,
  voiceoverStaleness,
  type VoiceoverSpan,
} from './voiceover'

type Client = SupabaseClient<Database>

export type ApplyFitResult =
  | { success: true; lengths: { id: string; seconds: number }[]; clamped: string[] }
  | { success: false; error: string }

/**
 * Fit to voiceover, server side: recomputed from a read's spans and the shots as they
 * stand - never from lengths a page sends - and refused with the same reasons the button
 * shows. Every in-film shot whose length changes is written in one upsert, so a fit lands
 * whole or not at all (re-running it is a no-op once it has). The button's fit (no `read`)
 * reads the stored spans and stamps last_fit_at itself; a new read's auto-fit passes its own
 * spans before it is linked, and its link write stamps last_fit_at. Free. The caller has
 * already checked the project is the user's and editable (the button) or is a worker acting
 * for its owner (auto-fit).
 */
export async function applyFitToVoiceover(
  supabase: Client,
  projectId: string,
  read?: { spans: readonly VoiceoverSpan[] }
): Promise<ApplyFitResult> {
  const [{ data: vo }, { data: shots, error: shotsError }] = await Promise.all([
    supabase.from('projects').select('audio_path, voiceover_spans, video_model').eq('id', projectId).maybeSingle(),
    supabase
      .from('shots')
      .select('id, shot_key, voice_over, order_index, film_order, binned_at, duration_sec, film_duration_sec')
      .eq('project_id', projectId),
  ])
  if (shotsError) return { success: false, error: shotsError.message }

  const spans = read ? [...read.spans] : parseSpans(vo?.voiceover_spans ?? null)
  const hasVoiceover = read ? true : !!vo?.audio_path && spans !== null
  const reason = fitUnavailableReason({
    hasVoiceover,
    inFlight: false,
    stale: hasVoiceover && voiceoverStaleness(spans!, shots ?? []).stale,
    orderDiffers: hasVoiceover && voiceoverOrderDiffers(spans!, shots ?? []),
  })
  if (reason) return { success: false, error: reason }
  const model = effectiveVideoModel({ video_model: vo?.video_model ?? null })
  if (!model) return { success: false, error: "This project's video model isn't available, so shot lengths can't be set." }

  const result = fitToVoiceover(spans!, shots ?? [], model)
  const updatedAt = new Date().toISOString()
  if (result.writes.length > 0) {
    const byId = new Map((shots ?? []).map((s) => [s.id, s]))
    const { error } = await supabase.from('shots').upsert(
      result.writes.map((w) => ({
        id: w.id,
        project_id: projectId,
        shot_key: byId.get(w.id)!.shot_key,
        order_index: byId.get(w.id)!.order_index,
        film_duration_sec: w.film_duration_sec,
        updated_at: updatedAt,
      })),
      { onConflict: 'id', defaultToNull: false }
    )
    if (error) return { success: false, error: error.message }
  }
  if (!read) {
    const { error: stampError } = await supabase
      .from('projects')
      .update({ last_fit_at: updatedAt, updated_at: updatedAt })
      .eq('id', projectId)
    if (stampError) return { success: false, error: stampError.message }
  }
  return { success: true, lengths: result.lengths, clamped: result.clamped }
}

/**
 * Runs for a new read before it is linked. The first read is always fitted, free. A later
 * one is refitted silently unless a person retimed shots by hand after the last fit - then
 * it is left for the Storyboard's "Refit timing?" question (isRefitPending). Never throws:
 * a fit that can't run (e.g. picture order differs) leaves the lengths as they were.
 * Returns whether it fitted, so the link write stamps last_fit_at with it.
 */
export async function autoFitAfterVoiceover(
  supabase: Client,
  projectId: string,
  spans: readonly VoiceoverSpan[]
): Promise<{ fitted: boolean }> {
  try {
    const { data } = await supabase.from('projects').select('last_fit_at, last_manual_retime_at').eq('id', projectId).maybeSingle()
    const fit = data?.last_fit_at ? Date.parse(data.last_fit_at) : null
    const manual = data?.last_manual_retime_at ? Date.parse(data.last_manual_retime_at) : null
    if (fit !== null && manual !== null && manual > fit) return { fitted: false }
    const result = await applyFitToVoiceover(supabase, projectId, { spans })
    if (!result.success) console.warn(`[voiceover] auto-fit skipped for project ${projectId}: ${result.error}`)
    return { fitted: result.success }
  } catch (err) {
    console.error(`[voiceover] auto-fit failed for project ${projectId}`, err)
    return { fitted: false }
  }
}
