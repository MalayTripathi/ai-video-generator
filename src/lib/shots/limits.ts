import { SHOTS_PER_CHUNK } from '@/lib/config/shots'

// Shot generation's limits, enforced in code rather than by prompt. They decide only whether
// a further request starts - code never drops a shot the model wrote. Pure - no I/O.

export type TierRange = { minSec: number; maxSec: number; targetSec: number }

/**
 * The project's shot ceiling: the tier's maximum seconds over the video model's shortest
 * shot (30-60s on a 2s model: 60 / 2 = 30 shots). Reaching it stops further requests; it
 * never deletes a written shot.
 */
export function shotCeiling(tierMaxSec: number, modelMinSec: number): number {
  return Math.max(1, Math.floor(tierMaxSec / modelMinSec))
}

/** The most shots one request for a scene asks for: its seconds over the model's shortest shot. */
export function sceneMaxShots(sceneSec: number, modelMinSec: number): number {
  return Math.max(1, Math.floor(sceneSec / modelMinSec))
}

export type FittedOutline = {
  /** Whole seconds per kept scene, summing to the tier's target. */
  seconds: number[]
  /** How many leading scenes are kept - fewer than given only when even the model's
   * shortest shot per scene would overrun the tier. */
  kept: number
  rescaled: boolean
}

/**
 * The outline's scene seconds, made whole and rescaled to the tier's target (the middle of
 * its range), in proportion, before any shot is written. The space up to the tier's maximum
 * is headroom, never plan. Every scene keeps at least the model's shortest shot.
 */
export function fitOutlineSeconds(raw: readonly number[], tier: TierRange, modelMinSec: number): FittedOutline {
  const minScene = Math.max(1, Math.ceil(modelMinSec))
  const kept = Math.min(raw.length, Math.max(1, Math.floor(tier.maxSec / minScene)))
  const planned = raw.slice(0, kept).map((s) => (Number.isFinite(s) && s > 0 ? s : minScene))

  // Largest-remainder apportionment of the target over the planned proportions, on top of
  // each scene's minimum, so the result sums to exactly the target in whole seconds.
  const target = Math.max(tier.minSec, Math.min(tier.maxSec, Math.max(tier.targetSec, minScene * kept)))
  const spare = target - minScene * kept
  const weight = planned.reduce((a, b) => a + b, 0)
  const shares = planned.map((s) => (spare * s) / weight)
  const seconds = shares.map((share) => minScene + Math.floor(share))
  let left = target - seconds.reduce((a, b) => a + b, 0)
  const order = shares.map((share, i) => ({ i, frac: share - Math.floor(share) })).sort((a, b) => b.frac - a.frac)
  for (let k = 0; left > 0 && k < order.length; k++, left--) seconds[order[k].i] += 1
  const unchanged = kept === raw.length && seconds.every((s, i) => s === raw[i])
  return { seconds, kept, rescaled: !unchanged }
}

/** One scene's shots split into chunk sizes of at most `perChunk` (19 at 8 -> 8, 8, 3). */
export function chunkSizes(sceneShots: number, perChunk: number = SHOTS_PER_CHUNK): number[] {
  const sizes: number[] = []
  for (let left = sceneShots; left > 0; left -= perChunk) sizes.push(Math.min(perChunk, left))
  return sizes
}

/**
 * The seconds past which a scene gets no further request: its share of the tier's maximum
 * (its target x maximum / target). A scene running long in parallel can therefore never use
 * up the headroom a later scene needs. It stops requests only - shots already written stay.
 */
export function sceneRequestLimitSec(sceneTargetSec: number, tier: Pick<TierRange, 'maxSec' | 'targetSec'>): number {
  return (sceneTargetSec * tier.maxSec) / Math.max(1, tier.targetSec)
}
