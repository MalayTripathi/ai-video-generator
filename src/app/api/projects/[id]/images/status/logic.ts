import type { createClient } from '@/lib/supabase/server'
import { STATUS_POLL_INTERVAL_MS } from '@/lib/config/storyboard'
import { deriveImageState, type ImageState } from '@/lib/storyboard/image-state'

type SupabaseServerClient = Awaited<ReturnType<typeof createClient>>

export type ShotImageStatus = { shotId: string; state: ImageState; imagePath: string | null }

export type ImageStatusResult =
  | { ok: true; data: { shots: ShotImageStatus[]; pollIntervalMs: number } }
  | { ok: false; status: 404 | 500; error: string }

/**
 * Per-shot storyboard image state for one project: two narrow selects and a pure
 * derivation, cheap enough to poll. Paths are returned unsigned - signing is the page's
 * concern. imagePath is present for every state, so a failed regenerate can still show
 * the image it was replacing.
 */
export async function loadImageStatuses(params: {
  supabase: SupabaseServerClient
  projectId: string
  userId: string
}): Promise<ImageStatusResult> {
  const { supabase, projectId, userId } = params

  const { data: project } = await supabase
    .from('projects')
    .select('id')
    .eq('id', projectId)
    .eq('user_id', userId)
    .maybeSingle()
  if (!project) return { ok: false, status: 404, error: 'Project not found' }

  const [shotsResult, claimsResult] = await Promise.all([
    supabase
      .from('shots')
      .select('id, image_path, image_stale')
      .eq('project_id', projectId)
      .order('order_index', { ascending: true }),
    supabase
      .from('generations')
      .select('shot_id, state, started_at, queued_at')
      .eq('project_id', projectId)
      .eq('step', 'storyboard')
      .eq('operation', 'generate_image'),
  ])
  if (shotsResult.error) return { ok: false, status: 500, error: shotsResult.error.message }
  if (claimsResult.error) return { ok: false, status: 500, error: claimsResult.error.message }

  const claimByShot = new Map((claimsResult.data ?? []).map((row) => [row.shot_id, row]))
  const now = Date.now()
  const shots = (shotsResult.data ?? []).map((shot) => ({
    shotId: shot.id,
    state: deriveImageState(shot, claimByShot.get(shot.id) ?? null, now),
    imagePath: shot.image_path,
  }))

  return { ok: true, data: { shots, pollIntervalMs: STATUS_POLL_INTERVAL_MS } }
}
