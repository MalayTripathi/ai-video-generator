import { test, expect } from '@playwright/test'
import { VIDEO_MODELS } from '../src/lib/config/models'
import { durationConfig } from '../src/lib/config/duration'
import { SHOT_DURATION_PAD_SEC, SHOT_ORDER_BASE, spokenWordsPerSec } from '../src/lib/config/shots'
import { computeShotDuration, maxNarrationWordsPerShot, roundUpToModelDuration, spokenWordCount } from '../src/lib/shots/durations'
import { acceptWithinLimits, chunkSizes, fitOutlineSeconds, sceneMaxShots, shotCeiling } from '../src/lib/shots/limits'
import { chunkShotOrderIndex, resequence } from '../src/lib/shots/positions'

// Shot generation's code-enforced rules, with no I/O: durations from words, the tier and
// ceiling limits, the outline rescale, and the provisional-position re-sequence.

const wan3 = VIDEO_MODELS['wan-3.0'] // 2-30s, whole seconds
const wan25 = VIDEO_MODELS['wan-2.5'] // exactly 5s or 10s
const kling = VIDEO_MODELS['kling-v3-standard'] // 3-15s

const words = (n: number) => Array.from({ length: n }, (_, i) => `w${i}`).join(' ')

test.describe('shot durations - computed from words, never chosen by Claude', () => {
  test('a narrated shot: words / words-per-second + padding, rounded up to a whole second', () => {
    expect(spokenWordsPerSec('en')).toBe(2.17)
    // 13 words / 2.17 = 5.99s + 0.25 = 6.24 -> 7s
    const d = computeShotDuration({ narration: words(13), dialogue: [], silentEstimateSec: 2, language: 'en', model: wan3 })
    expect(d).toEqual({ seconds: 7, narrationOverflow: false })
  })

  test('dialogue words count with the narration', () => {
    // (4 + 6) words / 2.17 = 4.61 + 0.25 = 4.86 -> 5s
    const d = computeShotDuration({ narration: words(4), dialogue: [words(6)], silentEstimateSec: null, language: 'en', model: wan3 })
    expect(d.seconds).toBe(5)
  })

  test('audio tags are not spoken words', () => {
    expect(spokenWordCount('[warmly] Hello there [slowly] friend')).toBe(3)
  })

  test('an unmeasured language uses the English pace', () => {
    expect(spokenWordsPerSec('hi')).toBe(2.17)
    expect(spokenWordsPerSec(null)).toBe(2.17)
  })

  test("a silent shot uses Claude's whole-second estimate, kept within the model's range", () => {
    expect(computeShotDuration({ narration: '', dialogue: [], silentEstimateSec: 6, language: 'en', model: wan3 }).seconds).toBe(6)
    expect(computeShotDuration({ narration: '', dialogue: [], silentEstimateSec: 0.4, language: 'en', model: wan3 }).seconds).toBe(2)
    expect(computeShotDuration({ narration: '', dialogue: [], silentEstimateSec: 90, language: 'en', model: wan3 }).seconds).toBe(30)
    expect(computeShotDuration({ narration: '', dialogue: [], silentEstimateSec: null, language: 'en', model: kling }).seconds).toBe(3)
  })

  test('short speech rises to the model minimum', () => {
    expect(computeShotDuration({ narration: 'Go.', dialogue: [], silentEstimateSec: null, language: 'en', model: kling }).seconds).toBe(3)
  })

  test("speech past the model's maximum is clamped there and flagged as an overflow", () => {
    const d = computeShotDuration({ narration: words(80), dialogue: [], silentEstimateSec: null, language: 'en', model: kling })
    expect(d).toEqual({ seconds: 15, narrationOverflow: true })
  })

  test('a discrete model takes its next allowed length', () => {
    expect(computeShotDuration({ narration: words(6), dialogue: [], silentEstimateSec: null, language: 'en', model: wan25 }).seconds).toBe(5)
    expect(computeShotDuration({ narration: words(12), dialogue: [], silentEstimateSec: null, language: 'en', model: wan25 }).seconds).toBe(10)
    expect(roundUpToModelDuration(10.5, wan25)).toBe(10)
  })

  test('every computed duration is a whole second on a range model', () => {
    for (let n = 0; n < 70; n++) {
      const { seconds } = computeShotDuration({ narration: words(n), dialogue: [], silentEstimateSec: 3, language: 'en', model: wan3 })
      expect(Number.isInteger(seconds)).toBe(true)
      expect(seconds).toBeGreaterThanOrEqual(2)
      expect(seconds).toBeLessThanOrEqual(30)
    }
  })

  test('the split rule names the most words one shot can hold at the model maximum', () => {
    expect(maxNarrationWordsPerShot(kling, 'en')).toBe(Math.floor(15 * 2.17))
    expect(SHOT_DURATION_PAD_SEC).toBe(0.25)
  })
})

test.describe('limits - enforced in code, whatever the description asks for', () => {
  test('the shot ceiling is the tier maximum over the model minimum (30-60s on Wan 3.0: 30 shots)', () => {
    expect(shotCeiling(durationConfig['30-60s'].targetSecondsMax, 2)).toBe(30)
    expect(shotCeiling(durationConfig['8-10min'].targetSecondsMax, 5)).toBe(120)
  })

  test('tier targets are the middle of each range', () => {
    expect(Object.values(durationConfig).map((t) => t.targetSeconds)).toEqual([45, 90, 240, 540])
    for (const t of Object.values(durationConfig)) expect(t.targetSeconds).toBe((t.targetSecondsMin + t.targetSecondsMax) / 2)
  })

  test('an outline inside the range is kept as planned, in whole seconds', () => {
    const fitted = fitOutlineSeconds([20.4, 30, 25], { minSec: 60, maxSec: 120, targetSec: 90 }, 2)
    expect(fitted).toEqual({ seconds: [20, 30, 25], kept: 3, rescaled: false })
  })

  test('an outline outside the range is rescaled into it, in proportion, before any shot is written', () => {
    const fitted = fitOutlineSeconds([300, 300], { minSec: 30, maxSec: 60, targetSec: 45 }, 2)
    expect(fitted.rescaled).toBe(true)
    expect(fitted.seconds.reduce((a, b) => a + b, 0)).toBe(45)
    expect(fitted.seconds).toEqual([23, 22])
    const short = fitOutlineSeconds([5, 5], { minSec: 480, maxSec: 600, targetSec: 540 }, 2)
    expect(short.seconds.reduce((a, b) => a + b, 0)).toBe(540)
  })

  test("every scene keeps at least the model's shortest shot, and scenes past what the tier can hold are dropped", () => {
    const fitted = fitOutlineSeconds(Array(40).fill(1), { minSec: 30, maxSec: 60, targetSec: 45 }, 5)
    expect(fitted.kept).toBe(12)
    expect(fitted.seconds.every((s) => s >= 5)).toBe(true)
    expect(fitted.seconds.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(60)
  })

  test('a scene asks for at most its seconds over the model minimum; chunks are at most N', () => {
    expect(sceneMaxShots(36, 2)).toBe(18)
    expect(chunkSizes(19, 8)).toEqual([8, 8, 3])
  })

  test('the running total stops at the ceiling and before the tier maximum seconds', () => {
    expect(acceptWithinLimits([3, 3, 3], { shots: 28, seconds: 10 }, { ceiling: 30, maxSec: 600 })).toEqual({ accepted: 2, limitReached: true })
    expect(acceptWithinLimits([5, 5, 5], { shots: 0, seconds: 52 }, { ceiling: 30, maxSec: 60 })).toEqual({ accepted: 1, limitReached: true })
    expect(acceptWithinLimits([2, 2], { shots: 0, seconds: 0 }, { ceiling: 30, maxSec: 60 })).toEqual({ accepted: 2, limitReached: false })
  })
})

test.describe('positions', () => {
  test('provisional positions come from the scene position and the place in the scene - parallel chunks never collide', () => {
    const seen = new Set<number>()
    for (let scene = 0; scene < 20; scene++)
      for (let chunk = 0; chunk < 3; chunk++)
        for (let i = 0; i < 8; i++) seen.add(chunkShotOrderIndex(scene, chunk, i))
    expect(seen.size).toBe(20 * 3 * 8)
    expect(Math.min(...seen)).toBeGreaterThanOrEqual(SHOT_ORDER_BASE)
  })

  test('the re-sequence orders by scene, keeps existing shots ahead of new ones in a scene, and is contiguous', () => {
    const shots = [
      { id: 'a0', order_index: 0, scenePosition: 0 },
      { id: 'b0', order_index: 1, scenePosition: 1 },
      { id: 'c-new', order_index: chunkShotOrderIndex(2, 0, 0), scenePosition: 2 },
      { id: 'b-new', order_index: chunkShotOrderIndex(1, 1, 0), scenePosition: 1 },
      { id: 'loose', order_index: 2, scenePosition: null },
    ]
    const moves = new Map(resequence(shots).map((m) => [m.id, m.order_index]))
    const final = shots.map((s) => ({ id: s.id, at: moves.get(s.id) ?? s.order_index })).sort((x, y) => x.at - y.at)
    expect(final.map((s) => s.id)).toEqual(['a0', 'b0', 'loose', 'b-new', 'c-new'])
    expect(final.map((s) => s.at)).toEqual([0, 1, 2, 3, 4])
  })
})
