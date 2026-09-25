import { test, expect } from '@playwright/test'
import {
  DISSOLVE_SEC,
  DUCK_ATTACK_SEC,
  DUCK_RELEASE_SEC,
  MIX_DUCK_DEPTH_DB,
  MIX_MUSIC_GAIN_DB,
  MIX_VOICE_GAIN_DB,
  MOTION_ZOOM,
} from '../src/lib/config/storyboard'
import {
  buildFilmTimeline,
  duckAt,
  duckEnvelope,
  formatDb,
  isMixDbAllowed,
  lineAt,
  motionTransform,
  resolveMix,
  snapMixDb,
  visualsAt,
  type FilmShot,
  type Mix,
  type StoredMix,
} from '../src/lib/storyboard/film'
import type { VoiceoverSpan } from '../src/lib/storyboard/voiceover'

// The one film timeline (Storyboard E) that preview plays and export renders. No browser, no DB.

const NULL_MIX: StoredMix = {
  mix_voice_gain_db: null,
  mix_music_gain_db: null,
  mix_duck_depth_db: null,
  mix_duck_bypass: null,
  music_muted: null,
  voiceover_muted: false,
}
const MIX: Mix = resolveMix(NULL_MIX)

function shots(durations: number[], overrides: Partial<FilmShot>[] = []): FilmShot[] {
  return durations.map((d, i) => ({
    id: `s${i}`,
    order_index: i,
    duration_sec: d,
    section_label: null,
    image_path: `img/${i}.webp`,
    ...(overrides[i] ?? {}),
  }))
}

function film(list: FilmShot[], extra: Partial<Parameters<typeof buildFilmTimeline>[0]> = {}) {
  return buildFilmTimeline({
    aspectRatio: '9:16',
    shots: list,
    voiceover: null,
    mix: MIX,
    ...extra,
  })
}

test.describe('film timeline - order, durations, splits', () => {
  test('segments follow film order and film durations, tiling the film exactly', () => {
    const list = shots([4, 5, 3], [{ film_order: 2 }, { film_order: 0, film_duration_sec: 6 }, { film_order: 1 }])
    const t = film(list, { defaultTransition: 'cut' })
    expect(t.segments.map((s) => s.shotId)).toEqual(['s1', 's2', 's0'])
    expect(t.segments.map((s) => [s.startSec, s.endSec])).toEqual([
      [0, 6],
      [6, 9],
      [9, 13],
    ])
    expect(t.totalSec).toBe(13)
    expect(t.segments.map((s) => s.shotIndex)).toEqual([0, 1, 2])
  })

  test('binned shots are excluded from the picture and the length', () => {
    const t = film(shots([4, 5, 3], [{}, { binned_at: '2026-09-26T00:00:00Z' }]), { defaultTransition: 'cut' })
    expect(t.segments.map((s) => s.shotId)).toEqual(['s0', 's2'])
    expect(t.totalSec).toBe(7)
  })

  test('a split shot plays as two segments of the same image with a hard switch between them', () => {
    const t = film(shots([4, 6], [{}, { split_at: 0.5, motion: 'push_in', split_motion: 'pan_left' }]), {
      defaultTransition: 'cut',
    })
    const parts = t.segments.filter((s) => s.shotId === 's1')
    expect(parts.map((s) => [s.part, s.motion, s.startSec, s.endSec])).toEqual([
      ['a', 'push_in', 4, 7],
      ['b', 'pan_left', 7, 10],
    ])
    expect(parts[0].showToSec).toBe(7)
    expect(parts[1].showFromSec).toBe(7)
    expect(parts.every((p) => p.imagePath === 'img/1.webp')).toBe(true)
  })
})

test.describe('film timeline - dissolves and forced cuts', () => {
  test('a dissolve overlaps the two shots by its length, centred on the join, without changing the length', () => {
    const t = film(shots([5, 5]), { defaultTransition: 'dissolve' })
    expect(t.totalSec).toBe(10)
    const [a, b] = t.segments
    expect(a.showToSec).toBeCloseTo(5 + DISSOLVE_SEC / 2)
    expect(b.showFromSec).toBeCloseTo(5 - DISSOLVE_SEC / 2)
  })

  test('mid-dissolve the incoming shot fades in over the outgoing one', () => {
    const t = film(shots([5, 5]), { defaultTransition: 'dissolve' })
    const start = visualsAt(t, 5 - DISSOLVE_SEC / 2 + 1e-4)
    expect(start.map((l) => l.segment.shotId)).toEqual(['s0', 's1'])
    expect(start[1].opacity).toBeCloseTo(0, 2)
    const mid = visualsAt(t, 5)
    expect(mid[0].opacity).toBe(1)
    expect(mid[1].opacity).toBeCloseTo(0.5)
    expect(visualsAt(t, 5 + DISSOLVE_SEC / 2 + 0.01).map((l) => [l.segment.shotId, l.opacity])).toEqual([['s1', 1]])
  })

  test('a cut shows exactly one shot either side of the join', () => {
    const t = film(shots([5, 5]), { defaultTransition: 'cut' })
    expect(visualsAt(t, 4.99).map((l) => l.segment.shotId)).toEqual(['s0'])
    expect(visualsAt(t, 5).map((l) => l.segment.shotId)).toEqual(['s1'])
  })

  test('a dissolve whose join falls inside a spoken word is forced to a cut', () => {
    const voiceover = {
      path: 'vo.mp3',
      durationSec: 10,
      spans: [],
      words: [[4.8, 5.3]] as [number, number][],
    }
    const t = film(shots([5, 5]), { defaultTransition: 'dissolve', voiceover })
    expect(t.joins[0].forced).toBe(true)
    expect(t.segments[0].showToSec).toBe(5)
    expect(t.segments[1].showFromSec).toBe(5)
  })
})

test.describe('motion transforms', () => {
  test('push in grows to the zoom, pull out shrinks from it, static holds', () => {
    expect(motionTransform('push_in', 0).scale).toBe(1)
    expect(motionTransform('push_in', 1).scale).toBeCloseTo(MOTION_ZOOM)
    expect(motionTransform('pull_out', 0).scale).toBeCloseTo(MOTION_ZOOM)
    expect(motionTransform('static', 0.5)).toEqual({
      scale: 1,
      xPct: 0,
      yPct: 0,
    })
  })

  test('pans travel in opposite directions and progress is clamped', () => {
    expect(motionTransform('pan_left', 1).xPct).toBe(-motionTransform('pan_right', 1).xPct)
    expect(motionTransform('pan_up', 2)).toEqual(motionTransform('pan_up', 1))
  })
})

test.describe('ducking envelope', () => {
  test('reaches full depth over the attack and recovers over the release', () => {
    const points = duckEnvelope([[2, 3]], { depthDb: -9, bypass: false })
    expect(points).toEqual([
      { t: 2 - DUCK_ATTACK_SEC, db: 0 },
      { t: 2, db: -9 },
      { t: 3, db: -9 },
      { t: 3 + DUCK_RELEASE_SEC, db: 0 },
    ])
    expect(duckAt(points, 1)).toBe(0)
    expect(duckAt(points, 2 - DUCK_ATTACK_SEC / 2)).toBeCloseTo(-4.5)
    expect(duckAt(points, 2.5)).toBe(-9)
    expect(duckAt(points, 3 + DUCK_RELEASE_SEC / 2)).toBeCloseTo(-4.5)
    expect(duckAt(points, 4)).toBe(0)
  })

  test('close words merge into one held region; distant ones stay separate', () => {
    const close = duckEnvelope(
      [
        [1, 1.4],
        [1.5, 2],
      ],
      { depthDb: -6, bypass: false }
    )
    expect(close).toHaveLength(4)
    expect(duckAt(close, 1.45)).toBe(-6)
    const apart = duckEnvelope(
      [
        [1, 1.4],
        [3, 3.5],
      ],
      { depthDb: -6, bypass: false }
    )
    expect(apart).toHaveLength(8)
    expect(duckAt(apart, 2.5)).toBe(0)
  })

  test('bypass, zero depth or no words mean no duck', () => {
    expect(duckEnvelope([[1, 2]], { depthDb: -9, bypass: true })).toEqual([])
    expect(duckEnvelope([[1, 2]], { depthDb: 0, bypass: false })).toEqual([])
    expect(duckEnvelope(null, { depthDb: -9, bypass: false })).toEqual([])
  })

  test('the timeline ducks from the voiceover word timings with the mix depth', () => {
    const voiceover = {
      path: 'vo.mp3',
      durationSec: 10,
      spans: [],
      words: [[2, 3]] as [number, number][],
    }
    const t = film(shots([5, 5]), { voiceover })
    expect(duckAt(t.audio.duck, 2.5)).toBe(MIX_DUCK_DEPTH_DB.default)
    const bypassed = film(shots([5, 5]), {
      voiceover,
      mix: { ...MIX, duckBypass: true },
    })
    expect(bypassed.audio.duck).toEqual([])
  })
})

test.describe('audio lanes and the voiceover line', () => {
  const spans: VoiceoverSpan[] = [
    {
      shotId: 's0',
      from: 0,
      to: 10,
      text: 'First line.',
      startSec: 0.2,
      endSec: 2,
    },
    {
      shotId: 's1',
      from: 11,
      to: 22,
      text: 'Second line.',
      startSec: 5.1,
      endSec: 7,
    },
  ]
  const voiceover = {
    path: 'vo.mp3',
    durationSec: 8,
    spans,
    words: [
      [0.2, 0.8],
      [0.9, 2],
      [5.1, 6],
      [6.1, 7],
    ] as [number, number][],
  }

  test('a muted voiceover lane is omitted; otherwise it carries its gain', () => {
    expect(film(shots([5, 5]), { voiceover }).audio.voice).toEqual({
      path: 'vo.mp3',
      durationSec: 8,
      gainDb: 0,
    })
    expect(film(shots([5, 5]), { voiceover, mix: { ...MIX, voiceMuted: true } }).audio.voice).toBeNull()
    expect(film(shots([5, 5]), { voiceover }).audio.music).toBeNull()
  })

  test('the now line is the narration holding the current or last spoken word', () => {
    const t = film(shots([5, 5]), { voiceover })
    expect(lineAt(t, 0.1)).toBeNull()
    expect(lineAt(t, 1)?.text).toBe('First line.')
    expect(lineAt(t, 4)?.text).toBe('First line.')
    expect(lineAt(t, 5.2)?.text).toBe('Second line.')
  })

  test('chapters start at each named section', () => {
    const t = film(shots([4, 3, 5], [{ section_label: 'Rise' }, { section_label: 'Rise' }, { section_label: 'Fall' }]))
    expect(t.chapters).toEqual([
      { title: 'Rise', startSec: 0 },
      { title: 'Fall', startSec: 7 },
    ])
  })
})

test.describe('mix settings', () => {
  test('null columns resolve to the config defaults', () => {
    expect(resolveMix(NULL_MIX)).toEqual({
      voiceGainDb: MIX_VOICE_GAIN_DB.default,
      musicGainDb: MIX_MUSIC_GAIN_DB.default,
      duckDepthDb: MIX_DUCK_DEPTH_DB.default,
      duckBypass: false,
      voiceMuted: false,
      musicMuted: false,
    })
  })

  test('stored values are used and clamped; slider values snap to the grid', () => {
    expect(resolveMix({ ...NULL_MIX, mix_voice_gain_db: -3, mix_duck_bypass: true }).voiceGainDb).toBe(-3)
    expect(resolveMix({ ...NULL_MIX, mix_voice_gain_db: 99 }).voiceGainDb).toBe(MIX_VOICE_GAIN_DB.max)
    expect(snapMixDb(-3.3, MIX_VOICE_GAIN_DB)).toBe(-3.5)
    expect(isMixDbAllowed(-3.5, MIX_VOICE_GAIN_DB)).toBe(true)
    expect(isMixDbAllowed(-3.3, MIX_VOICE_GAIN_DB)).toBe(false)
    expect(isMixDbAllowed(100, MIX_VOICE_GAIN_DB)).toBe(false)
    expect(formatDb(-14)).toBe('−14.0 dB')
    expect(formatDb(0)).toBe('0.0 dB')
  })
})
