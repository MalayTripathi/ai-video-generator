import { test, expect } from '@playwright/test'
import {
  ALTERNATE_MOTION_CYCLE,
  DISSOLVE_SEC,
  FILM_DEFAULT_MOTION,
  FILM_DEFAULT_TRANSITION,
  STORYBOARD_MIN_SHOT_SEC,
} from '../src/lib/config/storyboard'
import {
  clampSplit,
  effectiveSplit,
  insideWord,
  isSplitAllowed,
  parseWords,
  resolveJoins,
  resolveMotions,
  splitBounds,
  splitUnavailableReason,
  wordBoundaries,
  wordsFromStoredAlignment,
} from '../src/lib/storyboard/motion'
import { laneTotalSeconds } from '../src/lib/storyboard/timeline'

// Pure rules behind Motion & transitions mode (canvas 15d). No browser, no DB.

type Shot = {
  id: string
  duration_sec: number | null
  film_duration_sec?: number | null
  motion?: string | null
  split_at?: number | null
  split_motion?: string | null
  transition_out?: string | null
}

function lane(durations: number[], overrides: Partial<Shot>[] = []): Shot[] {
  return durations.map((d, i) => ({ id: `s${i}`, duration_sec: d, ...(overrides[i] ?? {}) }))
}

function playedMotions(shots: Shot[]): string[] {
  const resolved = resolveMotions(shots, FILM_DEFAULT_MOTION)
  return shots.flatMap((s) => {
    const r = resolved.get(s.id)!
    return r.splitMotion ? [r.motion, r.splitMotion] : [r.motion]
  })
}

test.describe('motion - Alternate', () => {
  test('with no overrides it plays the cycle by film position', () => {
    expect(playedMotions(lane([5, 5, 5, 5, 5, 5]))).toEqual([
      ...ALTERNATE_MOTION_CYCLE,
      ...ALTERNATE_MOTION_CYCLE.slice(0, 2),
    ])
  })

  test('never repeats a move on consecutive shots, whatever the overrides around it', () => {
    // An override equal to the cycle's next move would repeat it; Alternate skips past it.
    for (let at = 0; at < 6; at++) {
      for (const override of ALTERNATE_MOTION_CYCLE) {
        const overrides: Partial<Shot>[] = []
        overrides[at] = { motion: override }
        const shots = lane([5, 5, 5, 5, 5, 5], overrides)
        const played = playedMotions(shots)
        played.forEach((m, i) => {
          if (i === 0) return
          const resolved = resolveMotions(shots, FILM_DEFAULT_MOTION)
          const alternated = resolved.get(shots[i].id)!.storedMotion === null
          if (alternated) expect(m, `shot ${i} with ${override} at ${at}`).not.toBe(played[i - 1])
        })
      }
    }
  })

  test('respects overrides - even one that repeats its neighbour - and reports them as stored', () => {
    const shots = lane([5, 5, 5], [{ motion: 'static' }, { motion: 'static' }])
    const resolved = resolveMotions(shots, FILM_DEFAULT_MOTION)
    expect(resolved.get('s0')).toMatchObject({ motion: 'static', storedMotion: 'static' })
    expect(resolved.get('s1')).toMatchObject({ motion: 'static', storedMotion: 'static' })
    expect(resolved.get('s2')!.storedMotion).toBeNull()
    expect(resolved.get('s2')!.motion).not.toBe('static')
  })

  test('an unknown stored value follows the film default', () => {
    const resolved = resolveMotions(lane([5], [{ motion: 'spin' }]), FILM_DEFAULT_MOTION)
    expect(resolved.get('s0')).toMatchObject({ motion: ALTERNATE_MOTION_CYCLE[0], storedMotion: null })
  })

  test('a split shot plays two segments, each resolved, and Alternate never repeats across them', () => {
    const shots = lane([6, 6, 6], [{}, { split_at: 0.5 }])
    const resolved = resolveMotions(shots, FILM_DEFAULT_MOTION)
    expect(resolved.get('s1')!.splitAt).toBe(0.5)
    expect(resolved.get('s1')!.splitMotion).not.toBeNull()
    const played = playedMotions(shots)
    expect(played).toHaveLength(4)
    played.forEach((m, i) => i > 0 && expect(m).not.toBe(played[i - 1]))
    // The second segment's own motion wins.
    const own = resolveMotions(lane([6], [{ split_at: 0.5, split_motion: 'pan_up' }]), FILM_DEFAULT_MOTION).get('s0')!
    expect(own).toMatchObject({ splitMotion: 'pan_up', storedSplitMotion: 'pan_up' })
  })
})

test.describe('split', () => {
  test('bounds keep each segment at least the minimum shot length', () => {
    const b = splitBounds(5)!
    expect(b.min * 5).toBeCloseTo(STORYBOARD_MIN_SHOT_SEC)
    expect((1 - b.max) * 5).toBeCloseTo(STORYBOARD_MIN_SHOT_SEC)
  })

  test('a shot shorter than two minimum segments cannot split, and says why', () => {
    const tooShort = 2 * STORYBOARD_MIN_SHOT_SEC - 0.1
    expect(splitBounds(tooShort)).toBeNull()
    expect(splitUnavailableReason(tooShort)).toContain(`${STORYBOARD_MIN_SHOT_SEC.toFixed(1)}s`)
    expect(splitUnavailableReason(2 * STORYBOARD_MIN_SHOT_SEC)).toBeNull()
  })

  test('clampSplit stores a fraction, clamped to the minimum segment', () => {
    expect(clampSplit(0.5, 6)).toBe(0.5)
    expect(clampSplit(0.01, 5)).toBeCloseTo(STORYBOARD_MIN_SHOT_SEC / 5)
    expect(clampSplit(0.99, 5)).toBeCloseTo(1 - STORYBOARD_MIN_SHOT_SEC / 5)
    expect(clampSplit(0.5, 1)).toBeNull()
    expect(isSplitAllowed(0.5, 6)).toBe(true)
    expect(isSplitAllowed(0.05, 6)).toBe(false)
    expect(isSplitAllowed(0.5, 1.5)).toBe(false)
  })

  test('the stored fraction survives a retime: it scales with the shot, clamps, and a too-short shot plays whole', () => {
    const shot: Shot = { id: 's', duration_sec: 6, split_at: 0.25 }
    expect(effectiveSplit(shot)).toBe(0.25)
    expect(effectiveSplit({ ...shot, film_duration_sec: 10 })).toBe(0.25)
    // 3s: the first segment would be 0.75s, so it holds at the minimum.
    expect(effectiveSplit({ ...shot, film_duration_sec: 3 })).toBeCloseTo(STORYBOARD_MIN_SHOT_SEC / 3)
    expect(effectiveSplit({ ...shot, film_duration_sec: 1.5 })).toBeNull()
    expect(effectiveSplit({ ...shot, split_at: null })).toBeNull()
  })
})

test.describe('transitions', () => {
  test('a null join follows the film default; a stored one wins', () => {
    const joins = resolveJoins(lane([4, 4, 4], [{ transition_out: 'cut' }]), null, FILM_DEFAULT_TRANSITION)
    expect(joins).toHaveLength(2)
    expect(joins[0]).toMatchObject({ stored: 'cut', transition: 'cut', dissolveSec: 0 })
    expect(joins[1]).toMatchObject({ stored: null, chosen: FILM_DEFAULT_TRANSITION, transition: FILM_DEFAULT_TRANSITION })
  })

  test('a dissolve is centred on the join and leaves the total length unchanged', () => {
    const shots = lane([4, 6], [{ transition_out: 'dissolve' }])
    const [join] = resolveJoins(shots, null, FILM_DEFAULT_TRANSITION)
    expect(join.atSec).toBe(4)
    expect(join.dissolveSec).toBe(DISSOLVE_SEC)
    expect(join.startSec).toBeCloseTo(4 - DISSOLVE_SEC / 2)
    expect(join.endSec).toBeCloseTo(4 + DISSOLVE_SEC / 2)
    expect((join.startSec + join.endSec) / 2).toBeCloseTo(join.atSec)
    expect(laneTotalSeconds(shots)).toBe(10)
  })

  test('a dissolve is capped at half the shorter neighbouring shot', () => {
    const shortNeighbour = DISSOLVE_SEC // half of it is under DISSOLVE_SEC
    const [join] = resolveJoins(lane([shortNeighbour, 6], [{ transition_out: 'dissolve' }]), null, FILM_DEFAULT_TRANSITION)
    expect(join.dissolveSec).toBeCloseTo(shortNeighbour / 2)
  })
})

test.describe('forced cut', () => {
  const alignment = {
    // "one two": "one" 0.0-0.9, space, "two" 1.2-2.0
    characters: ['o', 'n', 'e', ' ', 't', 'w', 'o'],
    character_start_times_seconds: [0, 0.3, 0.6, 0.9, 1.2, 1.5, 1.8],
    character_end_times_seconds: [0.3, 0.6, 0.9, 1.2, 1.5, 1.8, 2.0],
  }

  test('word boundaries come from the alignment characters, split on spaces', () => {
    expect(wordBoundaries(alignment)).toEqual([
      [0, 0.9],
      [1.2, 2.0],
    ])
    expect(insideWord(1.5, wordBoundaries(alignment))).toBe(true)
    expect(insideWord(1.0, wordBoundaries(alignment))).toBe(false)
    expect(insideWord(1.2, wordBoundaries(alignment))).toBe(false)
  })

  test('the stored column and the stored alignment file both yield the same boundaries', () => {
    expect(wordsFromStoredAlignment(JSON.stringify({ text: 'one two', alignment, spans: [] }))).toEqual(wordBoundaries(alignment))
    expect(wordsFromStoredAlignment(JSON.stringify({ text: 'one three', alignment, spans: [] }))).toBeNull()
    expect(wordsFromStoredAlignment('not json')).toBeNull()
    expect(parseWords([[0, 0.9], [1.2, 2]])).toEqual([[0, 0.9], [1.2, 2]])
    expect(parseWords([[0, 'x']])).toBeNull()
    expect(parseWords(null)).toBeNull()
  })

  test('a dissolve whose join lands inside a spoken word resolves to Cut; the stored value is unchanged', () => {
    const shots = lane([1.5, 3], [{ transition_out: 'dissolve' }])
    const [join] = resolveJoins(shots, wordBoundaries(alignment), FILM_DEFAULT_TRANSITION)
    expect(join).toMatchObject({ stored: 'dissolve', chosen: 'dissolve', transition: 'cut', forced: true, dissolveSec: 0 })
    expect(shots[0].transition_out).toBe('dissolve')
  })

  test('a later retime that moves the join between words releases it', () => {
    const shots = lane([1.5, 3], [{ transition_out: 'dissolve', film_duration_sec: 1.0 }])
    const [join] = resolveJoins(shots, wordBoundaries(alignment), FILM_DEFAULT_TRANSITION)
    expect(join).toMatchObject({ transition: 'dissolve', forced: false })
  })

  test('with no voiceover nothing is forced', () => {
    const [join] = resolveJoins(lane([1.5, 3], [{ transition_out: 'dissolve' }]), null, FILM_DEFAULT_TRANSITION)
    expect(join).toMatchObject({ transition: 'dissolve', forced: false })
  })

  test('a chosen cut inside a word is simply a cut, never reported as forced', () => {
    const [join] = resolveJoins(lane([1.5, 3], [{ transition_out: 'cut' }]), wordBoundaries(alignment), FILM_DEFAULT_TRANSITION)
    expect(join).toMatchObject({ transition: 'cut', forced: false })
  })
})
