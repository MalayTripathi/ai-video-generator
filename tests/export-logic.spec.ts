import { test, expect } from '@playwright/test'
import { FILM_DEFAULT_MOTION, FILM_DEFAULT_TRANSITION, CAPTION_MAX_CHARS_PER_LINE } from '../src/lib/config/storyboard'
import { EXPORT_DEV_MAX_SEC, EXPORT_DEV_MAX_SHOTS } from '../src/lib/config/export'
import { resolveJoins, resolveMotions } from '../src/lib/storyboard/motion'
import { buildFilmTimeline, type FilmShot } from '../src/lib/storyboard/film'
import { resolveExportSettings, resolveFilmDefaults, exportSummary, type StoredExportSettings } from '../src/lib/export/settings'
import { toFilmInput, filmInputFromRows } from '../src/lib/export/film-input'
import { captionLines, toSrt } from '../src/lib/export/captions'
import { chaptersFfmetadata, chaptersTxt } from '../src/lib/export/chapters'
import { filmHash } from '../src/lib/export/film-hash'
import { buildRenderPlan, duckExpr } from '../src/lib/export/render-plan'
import { devCapError } from '../src/lib/export/dev-cap'
import { ExportJobError, planExport } from '../worker/job'

// Export (Storyboard F), pure rules: settings resolution and the film defaults it feeds B3's
// motion and transition resolution, caption lines, .srt, chapters, the render plan built
// from the shared film timeline, the dev size cap, and the film hash. No browser, no DB.

const NO_MIX = { mix_voice_gain_db: null, mix_music_gain_db: null, mix_duck_depth_db: null, mix_duck_bypass: null, music_muted: null }
const NONE: StoredExportSettings = {
  export_motion: null,
  export_transition: null,
  caption_mode: null,
  caption_style: null,
  caption_position: null,
  loudness_preset: null,
}

function shots(durations: number[], overrides: Partial<FilmShot>[] = []): FilmShot[] {
  return durations.map((d, i) => ({
    id: `s${i}`,
    order_index: i,
    duration_sec: d,
    scenes: null,
    image_path: `img/${i}.webp`,
    ...(overrides[i] ?? {}),
  }))
}

function film(list: FilmShot[], settings: Partial<StoredExportSettings> = {}, read: Parameters<typeof toFilmInput>[0]['read'] = null) {
  return buildFilmTimeline(toFilmInput({ aspectRatio: '9:16', shots: list, read, music: null, mix: NO_MIX, settings }))
}

test.describe('export settings resolution', () => {
  test('a null column falls back to the storyboard.ts default', () => {
    const s = resolveExportSettings(NONE, { hasVoiceover: true, aspectRatio: '9:16' })
    expect(s).toEqual({
      motion: FILM_DEFAULT_MOTION,
      transition: FILM_DEFAULT_TRANSITION,
      captions: 'off',
      captionStyle: 'reelcraft_default',
      captionPosition: 'bottom',
      loudness: 'streaming',
      aspectRatio: '9:16',
    })
    expect(exportSummary(s)).toBe('Alternate motion · Dissolve · Captions off · Streaming loudness')
  })

  test('a stored value wins; an unknown one falls back', () => {
    const s = resolveExportSettings(
      { ...NONE, export_motion: 'pan_up', export_transition: 'cut', caption_mode: 'burned', loudness_preset: 'broadcast' },
      { hasVoiceover: true, aspectRatio: '1:1' }
    )
    expect([s.motion, s.transition, s.captions, s.loudness]).toEqual(['pan_up', 'cut', 'burned', 'broadcast'])
    expect(resolveFilmDefaults({ export_motion: 'spin' }).motion).toBe(FILM_DEFAULT_MOTION)
  })

  test('captions are off without a voiceover, whatever is stored', () => {
    const s = resolveExportSettings({ ...NONE, caption_mode: 'both' }, { hasVoiceover: false, aspectRatio: '9:16' })
    expect(s.captions).toBe('off')
  })
})

test.describe('B3 resolution reads the project default', () => {
  test('a fixed default motion plays on every shot without its own; Alternate cycles', () => {
    const lane = shots([3, 3, 3], [{}, { motion: 'pan_down' }, {}])
    const fixed = resolveMotions(lane, 'static')
    expect([...fixed.values()].map((m) => m.motion)).toEqual(['static', 'pan_down', 'static'])
    const alternate = resolveMotions(lane, 'alternate')
    expect(alternate.get('s0')!.motion).toBe('push_in')
    expect(alternate.get('s1')!.motion).toBe('pan_down')
  })

  test('a join with no stored transition takes the project default', () => {
    const lane = shots([3, 3, 3], [{ transition_out: 'dissolve' }, {}])
    const joins = resolveJoins(lane, null, 'cut')
    expect(joins.map((j) => j.transition)).toEqual(['dissolve', 'cut'])
  })

  test('the film timeline resolves with the project settings', () => {
    const lane = shots([3, 3])
    const cut = film(lane, { export_motion: 'pull_out', export_transition: 'cut' })
    expect(cut.segments.map((s) => s.motion)).toEqual(['pull_out', 'pull_out'])
    expect(cut.joins[0].transition).toBe('cut')
    const fallback = film(lane)
    expect(fallback.joins[0].transition).toBe(FILM_DEFAULT_TRANSITION)
  })
})

test.describe('captions', () => {
  const lines = [
    { shotId: 'a', text: 'The river [slowly] bends', startSec: 0, endSec: 2 },
    { shotId: 'b', text: 'toward the old mill at dawn and keeps going far away', startSec: 2.5, endSec: 6 },
  ]
  // 4 tokens in span a (including the tag), 11 in span b.
  const words: [number, number][] = [
    [0, 0.3], [0.35, 0.5], [0.5, 0.6], [0.7, 1.9],
    [2.5, 2.8], [2.8, 2.9], [2.9, 3.0], [3.0, 3.2], [3.2, 3.4], [3.4, 3.6],
    [4.4, 4.6], [4.6, 4.8], [4.8, 5.1], [5.1, 5.4], [5.4, 6.0],
  ]

  test('lines break at shot boundaries, at pauses and at the character limit; tags are hidden', () => {
    const out = captionLines(lines, words, { maxChars: 24, pauseSec: 0.4 })
    expect(out.map((l) => l.text)).toEqual([
      'The river bends',
      'toward the old mill at',
      'dawn',
      'and keeps going far away',
    ])
    // The pause (3.6 → 4.4) breaks before "and", with the word timings as the edges.
    expect(out[2]).toEqual({ text: 'dawn', startSec: 3.4, endSec: 3.6 })
    expect(out[3].startSec).toBe(4.4)
    for (const line of out) expect(line.text.length).toBeLessThanOrEqual(24)
  })

  test('the default limit comes from storyboard.ts', () => {
    const long = captionLines([{ shotId: 'a', text: 'word '.repeat(30).trim(), startSec: 0, endSec: 30 }], null)
    for (const line of long) expect(line.text.length).toBeLessThanOrEqual(CAPTION_MAX_CHARS_PER_LINE)
  })

  test('a word-count mismatch falls back to each span’s own time range', () => {
    const out = captionLines(lines, words.slice(0, 5), { maxChars: 60 })
    expect(out).toHaveLength(2)
    expect(out[0].startSec).toBe(0)
    expect(out[1].startSec).toBe(2.5)
    expect(out[1].endSec).toBeLessThanOrEqual(6)
  })

  test('.srt numbers cues with hh:mm:ss,mmm times', () => {
    const srt = toSrt([
      { text: 'Hello there', startSec: 0.1, endSec: 1 },
      { text: 'Friend', startSec: 61.25, endSec: 3725.5 },
    ])
    expect(srt).toBe('1\n00:00:00,100 --> 00:00:01,000\nHello there\n\n2\n00:01:01,250 --> 01:02:05,500\nFriend\n')
  })
})

test.describe('chapters from scene titles', () => {
  const lane = shots([4, 4, 5, 3], [{ scenes: { title: 'Opening' } }, { scenes: { title: 'Opening' } }, { scenes: { title: 'The mill' } }, { scenes: null }])

  test('each labelled scene start becomes a chapter', () => {
    const t = film(lane)
    expect(t.chapters).toEqual([
      { title: 'Opening', startSec: 0 },
      { title: 'The mill', startSec: 8 },
    ])
    expect(chaptersTxt(t.chapters)).toBe('0:00 Opening\n0:08 The mill\n')
  })

  test('ffmetadata runs each chapter to the next, the last to the end', () => {
    const t = film(lane)
    expect(chaptersFfmetadata(t.chapters, t.totalSec)).toBe(
      ';FFMETADATA1\n[CHAPTER]\nTIMEBASE=1/1000\nSTART=0\nEND=8000\ntitle=Opening\n[CHAPTER]\nTIMEBASE=1/1000\nSTART=8000\nEND=16000\ntitle=The mill\n'
    )
  })
})

test.describe('render plan', () => {
  const project = {
    aspect_ratio: '9:16',
    audio_path: null,
    voiceover_generated_at: null,
    voiceover_source: null,
    voiceover_spans: null,
    voiceover_words: null,
    total_duration_sec: null,
    voiceover_muted: false,
    music_path: null,
    music_duration_sec: null,
    music_loop: false,
    user_id: 'u',
    ...NO_MIX,
    ...NONE,
  }
  const settings = resolveExportSettings(NONE, { hasVoiceover: false, aspectRatio: '9:16' })

  test('the job plans from the shared film timeline', () => {
    const rows = shots([2, 2], [{ split_at: 0.5 }, {}])
    const { timeline, plan } = planExport({ project, shots: rows, settings, isProduction: false, size: { width: 180, height: 320 } })
    const expected = buildFilmTimeline(filmInputFromRows(project, rows))
    expect(timeline).toEqual(expected)
    expect(plan.segments.map((s) => [s.shotId, s.motion])).toEqual(expected.segments.map((s) => [s.shotId, s.motion]))
    expect(plan.segments.map((s) => s.frames)).toEqual(
      expected.segments.map((s) => Math.round((s.showToSec - s.showFromSec) * plan.fps))
    )
    // The split's two segments meet at a cut; the join between shots is the default dissolve.
    expect(plan.joinFrames[0]).toBe(0)
    expect(plan.joinFrames[1]).toBeGreaterThan(0)
    expect(plan.totalSec).toBe(expected.totalSec)
    // No voiceover, no music: a silent track keeps the file's shape.
    expect(plan.audio).toEqual({ voice: null, music: null })
  })

  test('the snapshot’s motion and transition are the render’s film defaults', () => {
    const rows = shots([2, 2])
    const { plan } = planExport({
      project,
      shots: rows,
      settings: { ...settings, motion: 'pan_right', transition: 'cut' },
      isProduction: false,
    })
    expect(plan.segments.map((s) => s.motion)).toEqual(['pan_right', 'pan_right'])
    expect(plan.joinFrames).toEqual([0])
  })

  test('the dev size cap refuses a 3-shot export outside production', () => {
    const rows = shots([2, 2, 2])
    expect(3).toBeGreaterThan(EXPORT_DEV_MAX_SHOTS)
    expect(() => planExport({ project, shots: rows, settings, isProduction: false })).toThrow(ExportJobError)
    expect(() => planExport({ project, shots: rows, settings, isProduction: false })).toThrow(/limited to 2 shots/)
    expect(() => planExport({ project, shots: rows, settings, isProduction: true })).not.toThrow()
    expect(devCapError(film(shots([EXPORT_DEV_MAX_SEC + 1])), false)).not.toBeNull()
    expect(devCapError(film(shots([2, 2])), false)).toBeNull()
  })

  test('captions: sidecars only for the modes that ask for them', () => {
    const read = {
      audioPath: 'v.mp3',
      durationSec: 4,
      muted: false,
      spans: [{ shotId: 's0', from: 0, to: 5, text: 'Hello', startSec: 0.2, endSec: 0.8 }],
      words: [[0.2, 0.8]] as [number, number][],
    }
    const t = film(shots([2, 2]), {}, read)
    const base = { size: { width: 180, height: 320 }, fps: 30, crf: 20, upscale: 2 }
    const srtOnly = buildRenderPlan(t, { ...settings, captions: 'srt' }, base)
    expect(srtOnly.sidecars.srt).toContain('Hello')
    expect(srtOnly.sidecars.ass).toBeNull()
    expect(srtOnly.burnCaptions).toBe(false)
    const both = buildRenderPlan(t, { ...settings, captions: 'both', captionPosition: 'middle' }, base)
    expect(both.burnCaptions).toBe(true)
    expect(both.sidecars.ass).toContain('PlayResY: 320')
    // Middle centre (numpad 5).
    expect(both.sidecars.ass).toMatch(/Style: Caption,Inter,.*,5,\d+,\d+,0,1/)
    // Each shot's narration plays from its shot's start: the read's 0.2s lead-in is not played.
    expect(both.audio.voice).toEqual({ path: 'v.mp3', gainDb: 0, pieces: [{ shotId: 's0', fromSec: 0.2, toSec: 0.8, atSec: 0 }] })
  })

  test('the duck becomes a piecewise gain expression', () => {
    expect(duckExpr([])).toBe('1')
    const expr = duckExpr([
      { t: 1, db: 0 },
      { t: 1.1, db: -9 },
      { t: 2, db: -9 },
      { t: 2.3, db: 0 },
    ])
    expect(expr.startsWith('if(lt(t,1),1,')).toBe(true)
    expect(expr).toContain('pow(10,')
  })
})

test.describe('film hash', () => {
  test('stable for the same film, different after an edit', () => {
    const a = film(shots([3, 3]))
    expect(filmHash(a)).toBe(filmHash(film(shots([3, 3]))))
    expect(filmHash(a)).not.toBe(filmHash(film(shots([3, 3.5]))))
    expect(filmHash(a)).not.toBe(filmHash(film(shots([3, 3]), { export_transition: 'cut' })))
    expect(filmHash(a)).not.toBe(filmHash(film(shots([3, 3], [{ image_path: 'img/new.webp' }]))))
  })
})
