import { videoModelBounds, type VideoModelConfig } from '@/lib/config/models'
import { SHOT_DURATION_PAD_SEC, spokenWordsPerSec } from '@/lib/config/shots'
import { shotCountFor } from '@/lib/config/credits'
import { allowedModelDurations, roundUpToModelDuration } from './durations'

// Shot slots: code owns how many shots a scene gets and how long each one runs. The outline
// proposes a count per scene; code clamps it to what the video model can render in the
// scene's seconds, gives every slot a length the model allows so the scene's slots sum to its
// target as closely as those lengths permit, and keeps the project's total inside the tier's
// maximum. A slot's word cap is what its length holds at the language's pace. Pure - no I/O.

const EPS = 1e-9

/** The fewest and most shots a scene of `sceneSec` can take on this model. */
export function sceneSlotCountBounds(sceneSec: number, model: VideoModelConfig): { min: number; max: number } {
  const { min, max } = videoModelBounds(model)
  const fewest = Math.max(1, Math.ceil(sceneSec / max - EPS))
  // A model whose longest length is under twice its shortest can leave no count in range;
  // the fewer shots then win, each at the model's edge.
  const most = Math.max(fewest, Math.floor(sceneSec / min + EPS))
  return { min: fewest, max: most }
}

/** The outline's shot count for a scene, clamped to its bounds; a missing one is the scene's
 * seconds at the measured average shot. */
export function clampSlotCount(raw: unknown, sceneSec: number, model: VideoModelConfig): number {
  const bounds = sceneSlotCountBounds(sceneSec, model)
  const proposed = typeof raw === 'number' && Number.isFinite(raw) && raw >= 1 ? Math.round(raw) : shotCountFor(sceneSec)
  return Math.min(bounds.max, Math.max(bounds.min, proposed))
}

const total = (slots: readonly number[]) => slots.reduce((a, b) => a + b, 0)

/**
 * Lengths for `count` slots summing to `sceneSec` as closely as the model's lengths allow:
 * every slot starts at the allowed length nearest an even share, then the shortest slot is
 * lengthened (or the longest shortened) one allowed length at a time while that brings the
 * sum closer. Whole-second models land exactly; Wan 2.5 (5s or 10s) within 2.5s.
 */
export function assignSlotSeconds(sceneSec: number, count: number, model: VideoModelConfig): number[] {
  const allowed = allowedModelDurations(model)
  const nearest = (s: number) => allowed.reduce((best, d) => (Math.abs(d - s) < Math.abs(best - s) - EPS ? d : best), allowed[0])
  const slots = Array.from({ length: count }, () => nearest(sceneSec / count))
  for (;;) {
    const gap = sceneSec - total(slots)
    if (Math.abs(gap) < EPS) break
    const up = gap > 0
    // The slot to move: the shortest when lengthening, the longest when shortening, so the
    // scene's slots stay as even as the lengths allow.
    const order = slots.map((s, i) => ({ s, i })).sort((a, b) => (up ? a.s - b.s : b.s - a.s) || a.i - b.i)
    let moved = false
    for (const { s, i } of order) {
      const next = up ? allowed.find((d) => d > s + EPS) : [...allowed].reverse().find((d) => d < s - EPS)
      if (next === undefined) continue
      if (Math.abs(sceneSec - (total(slots) - s + next)) < Math.abs(gap) - EPS) {
        slots[i] = next
        moved = true
      }
      break
    }
    if (!moved) break
  }
  return slots
}

/**
 * Every scene's slots for one project: each scene's count clamped and its lengths assigned,
 * then - only if the rounding of every scene together passes the tier's maximum - the longest
 * slot of the scene furthest over its target is shortened one allowed length at a time until
 * the total fits (or no slot can be shortened).
 */
export function planProjectSlots(
  scenes: readonly { seconds: number; shotCount: unknown }[],
  model: VideoModelConfig,
  tierMaxSec: number
): number[][] {
  const plan = scenes.map((sc) => assignSlotSeconds(sc.seconds, clampSlotCount(sc.shotCount, sc.seconds, model), model))
  const allowed = allowedModelDurations(model)
  while (plan.reduce((sum, slots) => sum + total(slots), 0) > tierMaxSec + EPS) {
    const candidates = plan
      .map((slots, i) => ({ i, over: total(slots) - scenes[i].seconds }))
      .sort((a, b) => b.over - a.over)
    let shortened = false
    for (const { i } of candidates) {
      const slots = plan[i]
      const j = slots.reduce((best, s, k) => (s > slots[best] ? k : best), 0)
      const shorter = [...allowed].reverse().find((d) => d < slots[j] - EPS)
      if (shorter === undefined) continue
      slots[j] = shorter
      shortened = true
      break
    }
    if (!shortened) break
  }
  return plan
}

/** The spoken words - narration and dialogue together - a slot's length holds. */
export function slotWordCap(slotSec: number, language: string | null): number {
  return Math.max(0, Math.floor((slotSec - SHOT_DURATION_PAD_SEC) * spokenWordsPerSec(language) + EPS))
}

/**
 * A slotted shot's length: its slot's, when its words fit (a silent shot always keeps its
 * slot's); else the shortest length the model allows that holds them, up to the model's
 * longest - past that it keeps the longest and is flagged.
 */
export function fitShotToSlot(words: number, slotSec: number, language: string | null, model: VideoModelConfig): { seconds: number; narrationOverflow: boolean } {
  if (words <= slotWordCap(slotSec, language)) return { seconds: slotSec, narrationOverflow: false }
  const need = words / spokenWordsPerSec(language) + SHOT_DURATION_PAD_SEC
  return {
    seconds: Math.max(slotSec, roundUpToModelDuration(need, model)),
    narrationOverflow: need > videoModelBounds(model).max + EPS,
  }
}
