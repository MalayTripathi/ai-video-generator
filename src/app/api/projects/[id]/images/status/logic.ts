import type { createClient } from '@/lib/supabase/server'
// Type-only: the route injects the real function, so a plain-Node test can pass a fake.
import type { getBalance as getBalanceType } from '@/lib/credits/balance'
import { creditsFor } from '@/lib/config/credits'
import { STATUS_POLL_INTERVAL_MS, STORYBOARD_SIGNED_URL_EXPIRES_S } from '@/lib/config/storyboard'
import { deriveImageState, type ImageState } from '@/lib/storyboard/image-state'
import { countLiveImageClaims, storyboardThumbPath } from '../logic'

type SupabaseServerClient = Awaited<ReturnType<typeof createClient>>

export type ShotImageStatus = {
  shotId: string
  state: ImageState
  imagePath: string | null
  /** Signed URL of the full image, or null when there is none (or signing failed). */
  imageUrl: string | null
  /** Signed URL of the lane thumbnail; null when it doesn't exist - the page falls back to imageUrl. */
  thumbUrl: string | null
  startedAt: string | null
  queuedAt: string | null
  /** When the current image was drawn: the settled claim's updated_at, when that claim left an image. */
  drawnAt: string | null
}

export type ImageStatusData = {
  shots: ShotImageStatus[]
  pollIntervalMs: number
  /** When the signed URLs above expire - the page re-signs before this. */
  expiresAt: string
  /** Credits available for new images: ledger balance minus live image claims. Null if unreadable. */
  balanceCredits: number | null
}

export type ImageStatusResult =
  | { ok: true; data: ImageStatusData }
  | { ok: false; status: 404 | 500; error: string }

/**
 * Per-shot storyboard image state for one project, cheap enough to poll: two narrow
 * selects, a pure derivation, ONE batched signing call for every full image and thumbnail,
 * and the balance the case-2 banner needs. imagePath is present for every state, so a
 * failed regenerate still shows the image it was replacing.
 */
export async function loadImageStatuses(params: {
  supabase: SupabaseServerClient
  projectId: string
  userId: string
  getBalance: typeof getBalanceType
}): Promise<ImageStatusResult> {
  const { supabase, projectId, userId, getBalance } = params

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
      .select('shot_id, state, started_at, queued_at, updated_at')
      .eq('project_id', projectId)
      .eq('step', 'storyboard')
      .eq('operation', 'generate_image'),
  ])
  if (shotsResult.error) return { ok: false, status: 500, error: shotsResult.error.message }
  if (claimsResult.error) return { ok: false, status: 500, error: claimsResult.error.message }
  const shotRows = shotsResult.data ?? []

  const paths: string[] = []
  for (const shot of shotRows) {
    if (shot.image_path) paths.push(shot.image_path, storyboardThumbPath(shot.image_path))
  }
  const urlByPath = new Map<string, string>()
  if (paths.length > 0) {
    const { data: signed, error: signError } = await supabase.storage
      .from('artifacts')
      .createSignedUrls(paths, STORYBOARD_SIGNED_URL_EXPIRES_S)
    if (signError) {
      console.error(`[images/status] batch signing failed for project ${projectId}:`, signError.message)
    } else {
      // A thumbnail that was never written comes back as a per-entry error - that's the
      // expected fallback case, not a failure worth logging.
      for (const entry of signed ?? []) {
        if (!entry.error && entry.signedUrl && entry.path) urlByPath.set(entry.path, entry.signedUrl)
      }
    }
  }

  const claimByShot = new Map((claimsResult.data ?? []).map((row) => [row.shot_id, row]))
  const now = Date.now()
  const shots: ShotImageStatus[] = shotRows.map((shot) => {
    const claim = claimByShot.get(shot.id) ?? null
    const settled = claim !== null && (claim.state === 'succeeded' || claim.state === 'failed')
    return {
      shotId: shot.id,
      state: deriveImageState(shot, claim, now),
      imagePath: shot.image_path,
      imageUrl: shot.image_path ? (urlByPath.get(shot.image_path) ?? null) : null,
      thumbUrl: shot.image_path ? (urlByPath.get(storyboardThumbPath(shot.image_path)) ?? null) : null,
      startedAt: claim?.started_at ?? null,
      queuedAt: claim?.queued_at ?? null,
      drawnAt: settled && shot.image_path ? claim.updated_at : null,
    }
  })

  let balanceCredits: number | null = null
  try {
    const price = creditsFor({ step: 'storyboard', operation: 'generate_image', quantity: 1 })
    const committed = (await countLiveImageClaims(supabase, userId)) * price
    balanceCredits = Math.max(0, (await getBalance(userId)) - committed)
  } catch (err) {
    console.error(`[images/status] balance unreadable for project ${projectId}:`, err)
  }

  return {
    ok: true,
    data: {
      shots,
      pollIntervalMs: STATUS_POLL_INTERVAL_MS,
      expiresAt: new Date(now + STORYBOARD_SIGNED_URL_EXPIRES_S * 1000).toISOString(),
      balanceCredits,
    },
  }
}
