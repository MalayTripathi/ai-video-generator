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

/**
 * The project's unreserved seconds: the tier's maximum less what every scene holds - its
 * reservation, or what it has already written past it. Scenes overrun their reservation
 * only out of this, never out of another scene's reservation.
 */
export function unreservedSeconds(tierMaxSec: number, scenes: readonly { reservedSec: number; writtenSec: number }[]): number {
  const held = scenes.reduce((sum, s) => sum + Math.max(s.reservedSec, s.writtenSec), 0)
  return Math.max(0, tierMaxSec - held)
}

export type ChunkAcceptance = {
  /** How many of the chunk's shots (in order) are saved. */
  accepted: number
  /** Unreserved seconds the accepted shots took past the scene's reservation. */
  slackUsed: number
  /** The scene's seconds are spent: its reservation is written, or a shot was turned away by it. */
  sceneBudgetReached: boolean
  /** The project's shot ceiling or maximum seconds was reached. */
  projectLimitReached: boolean
}

/**
 * How many of a chunk's shots one scene keeps. Each must fit the scene's reserved seconds,
 * drawing on the project's unreserved seconds only past them, and the project's ceiling and
 * maximum seconds as a backstop. Pure; the caller applies `slackUsed` before its next await,
 * so scenes finishing together never both take the same unreserved seconds.
 */
export function acceptChunkShots(
  durations: readonly number[],
  scene: { reservedSec: number; writtenSec: number },
  slackLeft: number,
  totals: RunningTotals,
  limits: { ceiling: number; maxSec: number }
): ChunkAcceptance {
  const eps = 1e-9
  let written = scene.writtenSec
  let slackUsed = 0
  let accepted = 0
  for (const d of durations) {
    const extra = Math.max(0, written + d - Math.max(scene.reservedSec, written))
    if (extra > slackLeft - slackUsed + eps) {
      return { accepted, slackUsed, sceneBudgetReached: true, projectLimitReached: false }
    }
    const project = acceptWithinLimits([d], { shots: totals.shots + accepted, seconds: totals.seconds + (written - scene.writtenSec) }, limits)
    if (project.accepted === 0) return { accepted, slackUsed, sceneBudgetReached: false, projectLimitReached: true }
    slackUsed += extra
    written += d
    accepted += 1
  }
  return {
    accepted,
    slackUsed,
    // Its reservation written: the scene is done, whatever slack is left for other scenes.
    sceneBudgetReached: written >= scene.reservedSec - eps,
    projectLimitReached: totals.shots + accepted >= limits.ceiling,
  }
}
