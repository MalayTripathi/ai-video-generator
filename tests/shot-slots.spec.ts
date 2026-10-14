import { test, expect } from '@playwright/test'
import { VIDEO_MODELS, isDurationAllowed, videoModelBounds, type VideoModelConfig } from '../src/lib/config/models'
import { durationConfig } from '../src/lib/config/duration'
import { SHOT_DURATION_PAD_SEC, spokenWordsPerSec } from '../src/lib/config/shots'
import { fitOutlineSeconds } from '../src/lib/shots/limits'
import { allowedModelDurations } from '../src/lib/shots/durations'
import {
  assignSlotSeconds,
  clampSlotCount,
  fitShotToSlot,
  planProjectSlots,
  sceneSlotCountBounds,
  slotWordCap,
} from '../src/lib/shots/slots'

// Layer: api (pure). Code-owned shot slots: the outline's count per scene clamped to what the
// video model can render, every slot a length the model allows, a scene's slots summing to
// its target as closely as those lengths permit, the project inside the tier maximum, and a
// slot's word cap. Every registered video model, every tier.

const sum = (xs: readonly number[]) => xs.reduce((a, b) => a + b, 0)
const wan25 = VIDEO_MODELS['wan-2.5']
const wan3 = VIDEO_MODELS['wan-3.0']

/** Half the smallest gap between the model's lengths - the closest a sum can be forced. */
function worstGap(model: VideoModelConfig): number {
  const allowed = allowedModelDurations(model)
  const gaps = allowed.slice(1).map((d, i) => d - allowed[i])
  return Math.min(...gaps) / 2
}

// Outline shapes per tier: even scenes, uneven scenes, and wild shot counts (too few, too
// many, missing) - the bounds must hold whatever the model proposes.
const OUTLINES: { weights: number[]; counts: (number | null)[] }[] = [
  { weights: [1, 1, 1], counts: [3, 3, 3] },
  { weights: [5, 1, 2, 1], counts: [1, 1000, null, 0] },
  { weights: [1], counts: [null] },
  { weights: [2, 3, 1, 4, 1, 2], counts: [2, 50, 7, 1, 9, null] },
]

test.describe('shot slots - every model, every tier', () => {
  for (const [modelId, model] of Object.entries(VIDEO_MODELS)) {
    for (const [tierId, tier] of Object.entries(durationConfig)) {
      test(`${modelId} at ${tierId}: counts in bounds, valid lengths, scene sums on target, total within the tier maximum`, () => {
        const { min, max } = videoModelBounds(model)
        for (const outline of OUTLINES) {
          const fitted = fitOutlineSeconds(
            outline.weights.map((w) => (w * tier.targetSeconds) / sum(outline.weights)),
            { minSec: tier.targetSecondsMin, maxSec: tier.targetSecondsMax, targetSec: tier.targetSeconds },
            min
          )
          const scenes = fitted.seconds.map((seconds, i) => ({ seconds, shotCount: outline.counts[i] }))
          const plan = planProjectSlots(scenes, model, tier.targetSecondsMax)
          expect(plan).toHaveLength(scenes.length)
          plan.forEach((slots, i) => {
            const bounds = sceneSlotCountBounds(scenes[i].seconds, model)
            expect(slots.length).toBeGreaterThanOrEqual(bounds.min)
            expect(slots.length).toBeLessThanOrEqual(bounds.max)
            for (const s of slots) expect(isDurationAllowed(model, s)).toBe(true)
            for (const s of slots) expect(s >= min && s <= max).toBe(true)
            expect(Math.abs(sum(slots) - scenes[i].seconds)).toBeLessThanOrEqual(worstGap(model) + 1e-9)
          })
          expect(sum(plan.map(sum))).toBeLessThanOrEqual(tier.targetSecondsMax)
        }
      })
    }
  }
})

test.describe('slot counts', () => {
  test("a count is clamped to the scene's seconds over the model's longest and shortest lengths", () => {
    // Wan 3.0 renders 2-30s: a 30s scene takes 1 to 15 shots.
    expect(sceneSlotCountBounds(30, wan3)).toEqual({ min: 1, max: 15 })
    expect(clampSlotCount(40, 30, wan3)).toBe(15)
    expect(clampSlotCount(0, 30, wan3)).toBe(4) // missing or nonsense: 30s at the measured 8.45s average
    expect(clampSlotCount(null, 30, wan3)).toBe(4)
    // Wan 2.5 renders only 5s or 10s: a 22s scene takes 3 or 4 shots.
    expect(sceneSlotCountBounds(22, wan25)).toEqual({ min: 3, max: 4 })
    expect(clampSlotCount(1, 22, wan25)).toBe(3)
  })

  test('whole-second models split a scene evenly and land on its target exactly', () => {
    expect(assignSlotSeconds(30, 4, wan3)).toEqual([8, 8, 7, 7])
    expect(sum(assignSlotSeconds(37, 5, VIDEO_MODELS['kling-v3-standard']))).toBe(37)
  })

  test('Wan 2.5 (5s or 10s) lands within 2.5s of the target - its worst case', () => {
    const sorted = (xs: number[]) => [...xs].sort((a, b) => a - b)
    expect(sorted(assignSlotSeconds(22, 3, wan25))).toEqual([5, 5, 10]) // 20: 2s short
    expect(sorted(assignSlotSeconds(23, 3, wan25))).toEqual([5, 10, 10]) // 25: 2s over
    for (let sec = 5; sec <= 120; sec++) {
      const bounds = sceneSlotCountBounds(sec, wan25)
      for (let n = bounds.min; n <= bounds.max; n++) expect(Math.abs(sum(assignSlotSeconds(sec, n, wan25)) - sec)).toBeLessThanOrEqual(2.5)
    }
  })

  test('when every scene rounds up, the last pass shortens slots until the project fits the tier maximum', () => {
    // Thirteen 5s scenes over a 60s maximum at Wan 2.5 (an outline the rescale never produces).
    const plan = planProjectSlots(Array.from({ length: 13 }, () => ({ seconds: 5, shotCount: 1 })), wan25, 60)
    expect(sum(plan.map(sum))).toBe(65) // nothing left to shorten: each slot is already the model's shortest
    const over = planProjectSlots([{ seconds: 28, shotCount: 3 }, { seconds: 28, shotCount: 3 }], wan25, 50)
    expect(sum(over.map(sum))).toBeLessThanOrEqual(50)
  })
})

test.describe('word caps and lengths', () => {
  test("a slot's cap is the words its length holds under the words-per-second + padding formula", () => {
    expect(spokenWordsPerSec('en')).toBe(2.17)
    // (7 - 0.25) x 2.17 = 14.6 -> 14
    expect(slotWordCap(7, 'en')).toBe(Math.floor((7 - SHOT_DURATION_PAD_SEC) * 2.17))
    expect(slotWordCap(7, 'en')).toBe(14)
    expect(slotWordCap(5, 'en')).toBe(10)
  })

  test('a shot within its cap keeps its slot length - a silent one too', () => {
    expect(fitShotToSlot(14, 7, 'en', wan3)).toEqual({ seconds: 7, narrationOverflow: false })
    expect(fitShotToSlot(0, 7, 'en', wan3)).toEqual({ seconds: 7, narrationOverflow: false })
  })

  test('over its cap it is lengthened to the shortest length that fits; past the model maximum it keeps the maximum, flagged', () => {
    // 20 words: 20 / 2.17 + 0.25 = 9.47 -> 10s.
    expect(fitShotToSlot(20, 7, 'en', wan3)).toEqual({ seconds: 10, narrationOverflow: false })
    // Wan 2.5: 12 words need 5.78s -> 10s.
    expect(fitShotToSlot(12, 5, 'en', wan25)).toEqual({ seconds: 10, narrationOverflow: false })
    // 80 words need 37s: past Wan 3.0's 30s.
    expect(fitShotToSlot(80, 7, 'en', wan3)).toEqual({ seconds: 30, narrationOverflow: true })
  })
})
