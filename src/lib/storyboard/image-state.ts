import type { Tables } from '@/lib/database.types'
import { isLiveClaim } from '@/lib/generations/claim'

export const IMAGE_STATES = ['ready', 'stale', 'queued', 'generating', 'failed', 'not_generated'] as const
export type ImageState = (typeof IMAGE_STATES)[number]

type ShotImageFields = Pick<Tables<'shots'>, 'image_path' | 'image_stale'>
type ClaimFields = Pick<Tables<'generations'>, 'state' | 'started_at' | 'queued_at'>

/**
 * One shot's storyboard image state, from its own row plus its storyboard/generate_image
 * claim (null when it has never been claimed). Pure - the status endpoint's whole reading.
 *
 * - A live claim wins: queued while it waits behind the pool, generating once started.
 * - A claim past its window (isLiveClaim's rule, the same one the claim itself applies)
 *   reads as failed - its worker is gone, and it was never charged.
 * - Otherwise the stored image decides: stale only when there IS an image and it's flagged.
 */
export function deriveImageState(shot: ShotImageFields, claim: ClaimFields | null, now: number = Date.now()): ImageState {
  if (claim?.state === 'generating') {
    if (!isLiveClaim(claim, 'generate_image', now)) return 'failed'
    return claim.queued_at !== null ? 'queued' : 'generating'
  }
  if (claim?.state === 'failed') return 'failed'
  if (!shot.image_path) return 'not_generated'
  return shot.image_stale ? 'stale' : 'ready'
}
