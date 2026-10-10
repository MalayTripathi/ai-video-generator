import { test, expect } from '@playwright/test'
import { fixedCredits } from './helpers/prices'
import {
  MUSIC_END_FADE_SEC,
  MUSIC_LOOP_CROSSFADE_SEC,
  MUSIC_MAX_SEC,
  MUSIC_MIN_SEC,
  MUSIC_STYLE_PROMPT_MAX_CHARS,
} from '../src/lib/config/storyboard'
import { creditsFor, PRICE_TABLE } from '../src/lib/config/credits'
import { musicShorterThanPicture, requestedMusicSec } from '../src/lib/music/length'
import { cleanMusicStyle } from '../src/lib/prompts/music-style'
import { buildFilmTimeline, musicEnvelopeAt, musicSchedule, resolveMix, type FilmShot } from '../src/lib/storyboard/film'
import { currentMusic, toFilmInput } from '../src/lib/export/film-input'
import { filmHash } from '../src/lib/export/film-hash'
import { audioGraph, buildRenderPlan, loudnessAnalysisFilter, musicInputCount } from '../src/lib/export/render-plan'
import { resolveExportSettings } from '../src/lib/export/settings'
import { shorterMessage } from '../src/app/(app)/projects/[id]/storyboard/_components/music-card'

// Pure rules for the Storyboard music lane (Storyboard D): the requested length, the price,
// the loop/fade schedule the preview and export share, and the export's music chain. No
// browser, no DB, no provider.

const NO_MIX = { mix_voice_gain_db: null, mix_music_gain_db: null, mix_duck_depth_db: null, mix_duck_bypass: null }

function shots(durations: number[]): FilmShot[] {
  return durations.map((d, i) => ({
    id: `s${i}`,
    order_index: i,
    duration_sec: d,
    scenes: null,
    image_path: `img/${i}.webp`,
  }))
}

function film(durations: number[], music: { durationSec: number; loop?: boolean; muted?: boolean } | null) {
  return buildFilmTimeline(
    toFilmInput({
      aspectRatio: '9:16',
      shots: shots(durations),
      read: null,
      music: music ? { path: 'm.mp3', durationSec: music.durationSec, loop: music.loop ?? false, muted: music.muted ?? false } : null,
      mix: NO_MIX,
      settings: {},
    })
  )
}

test.describe('requested length', () => {
  test('follows the picture, clamped to the provider bounds', () => {
    expect(requestedMusicSec(34)).toBe(34)
    expect(requestedMusicSec(34.26)).toBe(34.3)
    expect(requestedMusicSec(1)).toBe(MUSIC_MIN_SEC)
    expect(requestedMusicSec(0)).toBe(MUSIC_MIN_SEC)
    expect(requestedMusicSec(10_000)).toBe(MUSIC_MAX_SEC)
  })
})

test.describe('per-minute pricing', () => {
  test('background_music is priced per minute of the requested length, rounded up once', () => {
    expect(PRICE_TABLE.storyboard?.background_music?.unit).toBe('per_minute')
    const perMinute = fixedCredits('storyboard', 'background_music')
    expect(creditsFor({ step: 'storyboard', operation: 'background_music', quantity: 60 })).toBe(perMinute)
    expect(creditsFor({ step: 'storyboard', operation: 'background_music', quantity: 34 })).toBe(Math.ceil((perMinute * 34) / 60))
    expect(creditsFor({ step: 'storyboard', operation: 'background_music', quantity: 600 })).toBe(perMinute * 10)
  })

  test('derive_music_prompt has no price - it is free to the user', () => {
    expect(PRICE_TABLE.storyboard?.derive_music_prompt).toBeUndefined()
  })
})

test.describe('shorter-than-picture warning and fade', () => {
  test('the warning shows once the picture grows past the music, and not when it shrinks', () => {
    // Made at 20s; the picture grew to 26s.
    expect(musicShorterThanPicture(20, 26, false)).toBe(true)
    // The picture shrank to 15s: no warning.
    expect(musicShorterThanPicture(20, 15, false)).toBe(false)
    // Looped: covered, no warning.
    expect(musicShorterThanPicture(20, 26, true)).toBe(false)
    expect(shorterMessage(28, 34)).toBe(
      'Music is 0:28 — six seconds shorter than the picture. It will fade out early unless you loop or extend it.'
    )
  })

  test('when the picture shrinks the music fades out ending at the picture’s end', () => {
    const t = film([5, 5], { durationSec: 20 })
    const music = t.audio.music!
    expect(t.totalSec).toBe(10)
    expect(music.plays).toEqual([{ startSec: 0, durationSec: 10, fadeInSec: 0, fadeOutSec: 0 }])
    expect(music.endSec).toBe(10)
    expect(music.endFadeSec).toBe(MUSIC_END_FADE_SEC)
    expect(musicEnvelopeAt(music, 5)).toBe(1)
    expect(musicEnvelopeAt(music, 10 - MUSIC_END_FADE_SEC / 2)).toBeCloseTo(0.5, 5)
    expect(musicEnvelopeAt(music, 10)).toBe(0)
  })

  test('a shorter, unlooped piece plays once and fades at its own end', () => {
    const music = film([10, 10], { durationSec: 12 }).audio.music!
    expect(music.looping).toBe(false)
    expect(music.plays).toHaveLength(1)
    expect(music.endSec).toBe(12)
    expect(musicEnvelopeAt(music, 15)).toBe(0)
  })
})

test.describe('loop to fit', () => {
  test('the builder loops the music with a crossfade until the picture ends', () => {
    const dur = 8
    const total = 20
    const s = musicSchedule(dur, total, true)
    const x = MUSIC_LOOP_CROSSFADE_SEC
    expect(s.looping).toBe(true)
    expect(s.endSec).toBe(total)
    // Each repeat starts one crossfade before the previous ends.
    expect(s.plays.map((p) => p.startSec)).toEqual([0, dur - x, 2 * (dur - x)])
    expect(s.plays[0]).toMatchObject({ fadeInSec: 0, fadeOutSec: x })
    expect(s.plays[1]).toMatchObject({ fadeInSec: x, fadeOutSec: x })
    // The last pass is cut at the picture's end and has no successor to fade into.
    const last = s.plays[2]
    expect(last.startSec + last.durationSec).toBeCloseTo(total, 9)
    expect(last).toMatchObject({ fadeInSec: x, fadeOutSec: 0 })
    // Mid-crossfade the two passes sum to full level; no gap anywhere.
    const mid = dur - x / 2
    expect(musicEnvelopeAt(s, mid)).toBeCloseTo(1, 5)
    for (let t = 0; t < total - MUSIC_END_FADE_SEC; t += 0.25) expect(musicEnvelopeAt(s, t)).toBeGreaterThan(0.99)
  })

  test('the loop flag is ignored when the music is already at least as long as the picture', () => {
    const s = musicSchedule(30, 20, true)
    expect(s.looping).toBe(false)
    expect(s.plays).toEqual([{ startSec: 0, durationSec: 20, fadeInSec: 0, fadeOutSec: 0 }])
  })

  test('the film carries the loop, and the hash changes with it', () => {
    const plain = film([10, 10], { durationSec: 8 })
    const looped = film([10, 10], { durationSec: 8, loop: true })
    expect(looped.audio.music!.looping).toBe(true)
    expect(looped.audio.music!.plays.length).toBeGreaterThan(1)
    expect(filmHash(plain)).not.toBe(filmHash(looped))
  })
})

test.describe('mute and the stored columns', () => {
  test('muted music is omitted from the film', () => {
    expect(film([5], { durationSec: 5, muted: true }).audio.music).toBeNull()
    expect(film([5], null).audio.music).toBeNull()
  })

  test('the current music comes from its columns; no path means none', () => {
    expect(currentMusic({ music_path: null, music_duration_sec: 3, music_loop: false, music_muted: null })).toBeNull()
    expect(currentMusic({ music_path: 'a.mp3', music_duration_sec: 12.5, music_loop: true, music_muted: true })).toEqual({
      path: 'a.mp3',
      durationSec: 12.5,
      loop: true,
      muted: true,
    })
    // The mix gain carries through.
    expect(resolveMix({ ...NO_MIX, music_muted: null, voiceover_muted: false }).musicGainDb).toBe(film([5], { durationSec: 5 }).audio.music!.gainDb)
  })
})

test.describe('export music chain', () => {
  const settings = resolveExportSettings({}, { hasVoiceover: true, aspectRatio: '9:16' })
  const opts = { size: { width: 180, height: 320 }, fps: 30, crf: 28, upscale: 2 }
  const read = {
    audioPath: 'v.mp3',
    durationSec: 6,
    spans: [{ shotId: 's0', from: 0, to: 5, text: 'Hello', startSec: 0.5, endSec: 1.5 }],
    words: [[0.5, 1.5]] as [number, number][],
    muted: false,
  }

  function plan(music: { durationSec: number; loop?: boolean; muted?: boolean } | null) {
    const timeline = buildFilmTimeline(
      toFilmInput({
        aspectRatio: '9:16',
        shots: shots([5, 5]),
        read,
        music: music ? { path: 'm.mp3', durationSec: music.durationSec, loop: music.loop ?? false, muted: music.muted ?? false } : null,
        mix: NO_MIX,
        settings: {},
      })
    )
    return buildRenderPlan(timeline, settings, opts)
  }

  test('the export includes the music, ducked under the voiceover, before loudness normalisation', () => {
    const p = plan({ durationSec: 20 })
    expect(p.audio.music).not.toBeNull()
    expect(musicInputCount(p)).toBe(1)
    const graph = audioGraph(p, [0], [1])
    expect(graph).toContain('[1:a]aresample=48000')
    // The duck; the word now plays from its shot's start, so its attack begins before 0.
    expect(graph).toMatch(/volume='if\(lt\(t,-?[\d.]+\),1,/)
    expect(graph).toContain(`afade=t=out:st=${10 - MUSIC_END_FADE_SEC}:d=${MUSIC_END_FADE_SEC}`) // the picture-end fade
    expect(graph).toContain('amix=inputs=2:normalize=0')
    expect(loudnessAnalysisFilter(p)).toContain('[amix]loudnorm=')
  })

  test('a looped piece plays every pass of the schedule on two alternating inputs, crossfaded', () => {
    const p = plan({ durationSec: 4, loop: true })
    const plays = p.audio.music!.plays
    expect(plays.length).toBeGreaterThan(2)
    expect(musicInputCount(p)).toBe(2)
    const graph = audioGraph(p, [0], [1, 2])
    const step = plays[1].startSec - plays[0].startSec
    // Each input is the file padded to two steps and looped; the odd passes start a step later.
    expect(graph).toContain(`[1:a]aresample=48000,apad=whole_dur=${2 * step}`)
    expect(graph).toContain(`[2:a]aresample=48000,apad=whole_dur=${2 * step}`)
    expect(graph).toContain(`adelay=delays=${step * 1000}:all=1`)
    // Every pass's window appears once, with its crossfade.
    for (const play of plays) expect(graph).toContain(`gte(t,${play.startSec})*lt(t,${play.startSec + play.durationSec})`)
    expect(graph).toContain(`(t-${plays[1].startSec})/${MUSIC_LOOP_CROSSFADE_SEC}`)
    expect(graph).not.toContain('asplit')
  })

  test('muted music is omitted from the export', () => {
    const p = plan({ durationSec: 20, muted: true })
    expect(p.audio.music).toBeNull()
    expect(musicInputCount(p)).toBe(0)
    expect(audioGraph(p, [0], null)).not.toContain('[music]')
  })
})

test.describe('derived style prompt', () => {
  test('one line, under the limit, quotes and extra whitespace dropped', () => {
    expect(cleanMusicStyle('  "Slow tabla and\n sustained strings, reverent, unhurried"  ')).toBe(
      'Slow tabla and sustained strings, reverent, unhurried'
    )
    const long = cleanMusicStyle('warm piano, '.repeat(30))!
    expect(long.length).toBeLessThan(MUSIC_STYLE_PROMPT_MAX_CHARS)
    expect(cleanMusicStyle('   ')).toBeNull()
    expect(cleanMusicStyle(42)).toBeNull()
  })
})
