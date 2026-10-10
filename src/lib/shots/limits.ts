import { SHOTS_PER_CHUNK } from '@/lib/config/shots'

// Shot generation's limits, enforced in code rather than by prompt, so a description can
// never push a project past its duration tier. Pure - no I/O.

export type TierRange = { minSec: number; maxSec: number; targetSec: number }

/**
 * The hard shot ceiling for a project: the tier's maximum seconds over the video model's
 * shortest shot (30-60s on a 2s model: 60 / 2 = 30 shots).
 */
export function shotCeiling(tierMaxSec: number, modelMinSec: number): number {
  return Math.max(1, Math.floor(tierMaxSec / modelMinSec))
}

/** The most shots one scene may ask for: its seconds over the model's shortest shot. */
export function sceneMaxShots(sceneSec: number, modelMinSec: number): number {
  return Math.max(1, Math.floor(sceneSec / modelMinSec))
}

export type FittedOutline = {
  /** Whole seconds per kept scene, summing to a total inside the tier's range. */
  seconds: number[]
  /** How many leading scenes are kept - fewer than given only when even the model's
   * shortest shot per scene would overrun the tier. */
  kept: number
  rescaled: boolean
}

/**
 * The outline's scene seconds, made whole and kept inside the tier's range. A total
 * already inside the range is left as the outline planned it (rounded to whole seconds);
 * one outside is rescaled to the tier's target, in proportion, before any shot is written.
 * Every scene keeps at least the model's shortest shot.
 */
export function fitOutlineSeconds(raw: readonly number[], tier: TierRange, modelMinSec: number): FittedOutline {
  const minScene = Math.max(1, Math.ceil(modelMinSec))
  const kept = Math.min(raw.length, Math.max(1, Math.floor(tier.maxSec / minScene)))
  const planned = raw.slice(0, kept).map((s) => (Number.isFinite(s) && s > 0 ? s : minScene))
  const rounded = planned.map((s) => Math.max(minScene, Math.round(s)))
  const total = rounded.reduce((a, b) => a + b, 0)
  if (total >= tier.minSec && total <= tier.maxSec) {
    return { seconds: rounded, kept, rescaled: kept < raw.length }
  }

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
  return { seconds, kept, rescaled: true }
}

/** One scene's shots split into chunk sizes of at most `perChunk` (19 at 8 -> 8, 8, 3). */
export function chunkSizes(sceneShots: number, perChunk: number = SHOTS_PER_CHUNK): number[] {
  const sizes: number[] = []
  for (let left = sceneShots; left > 0; left -= perChunk) sizes.push(Math.min(perChunk, left))
  return sizes
}

export type RunningTotals = { shots: number; seconds: number }

/**
 * How many of a chunk's shots (in order, with their computed durations) may be saved:
 * stops at the project's shot ceiling and before the shot that would take the total past
 * the tier's maximum seconds. `limitReached` is true when either stop applied.
 */
export function acceptWithinLimits(
  durations: readonly number[],
  totals: RunningTotals,
  limits: { ceiling: number; maxSec: number }
): { accepted: number; limitReached: boolean } {
  let shots = totals.shots
  let seconds = totals.seconds
  let accepted = 0
  for (const d of durations) {
    if (shots >= limits.ceiling || seconds + d > limits.maxSec + 1e-9) return { accepted, limitReached: true }
    shots += 1
    seconds += d
    accepted += 1
  }
  return { accepted, limitReached: shots >= limits.ceiling || seconds >= limits.maxSec - 1e-9 }
}
