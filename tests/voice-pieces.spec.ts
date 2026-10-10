import { test, expect } from '@playwright/test'
import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { buildFilmTimeline, placeWords, voicePieces, type FilmShot } from '../src/lib/storyboard/film'
import { toFilmInput } from '../src/lib/export/film-input'
import { resolveExportSettings } from '../src/lib/export/settings'
import { audioGraph, buildRenderPlan, voiceInputCount, voiceRuns } from '../src/lib/export/render-plan'
import { captionLines } from '../src/lib/export/captions'
import type { VoiceoverSpan } from '../src/lib/storyboard/voiceover'
import { ffmpegPath } from '../worker/config'
import { runFfmpeg } from '../worker/ffmpeg'

// Voice placement (decision 19): each shot's narration piece starts at its own shot's start,
// so the voice pauses through a silent shot, and an overflowing piece pushes the next one
// back instead of overlapping it. One schedule drives preview, export, captions, the duck
// and the forced-cut rule.

function shots(durations: number[]): FilmShot[] {
  return durations.map((d, i) => ({ id: `s${i}`, order_index: i, duration_sec: d, scenes: null, image_path: `img/${i}.webp` }))
}

function span(shotId: string, startSec: number, endSec: number, text: string): VoiceoverSpan {
  return { shotId, from: 0, to: text.length, text, startSec, endSec }
}

const NO_MIX = { mix_voice_gain_db: null, mix_music_gain_db: null, mix_duck_depth_db: null, mix_duck_bypass: null }

function timeline(lane: FilmShot[], spans: VoiceoverSpan[], words: [number, number][], durationSec = 10) {
  return buildFilmTimeline(
    toFilmInput({
      aspectRatio: '9:16',
      shots: lane,
      read: { audioPath: 'v.mp3', durationSec, spans, words, muted: false },
      music: null,
      mix: NO_MIX,
      settings: {},
    })
  )
}

test.describe('voice pieces', () => {
  test("each piece starts at its shot's start - the voice pauses through a silent shot", () => {
    // Shots of 3s, 4s (silent), 3s. Read: a 0.0-2.0, c 2.1-4.0 (the silent shot has no speech).
    const lane = shots([3, 4, 3])
    const spans = [span('s0', 0, 2, 'One two'), { shotId: 's1', from: 7, to: 7, text: '', startSec: 2, endSec: 2 }, span('s2', 2.1, 4, 'Three four')]
    expect(voicePieces(lane, spans)).toEqual([
      { shotId: 's0', fromSec: 0, toSec: 2, atSec: 0 },
      { shotId: 's2', fromSec: 2.1, toSec: 4, atSec: 7 },
    ])
  })

  test('a piece longer than its shot keeps playing; the next starts at the later of its shot start and the previous end - never overlapping', () => {
    // Shot 0 is 2s but speaks 3.5s; shot 1 starts at 2s but its piece waits until 3.5s.
    const lane = shots([2, 3])
    const spans = [span('s0', 0, 3.5, 'Long overflowing line'), span('s1', 3.6, 5, 'Next')]
    const pieces = voicePieces(lane, spans)
    expect(pieces[1].atSec).toBe(3.5)
    expect(pieces[1].atSec).toBeGreaterThanOrEqual(pieces[0].atSec + (pieces[0].toSec - pieces[0].fromSec))
  })

  test('captions, word timings and the duck follow the placed pieces, not the read clock', () => {
    const lane = shots([3, 4, 3])
    const spans = [span('s0', 0, 2, 'One two'), { shotId: 's1', from: 7, to: 7, text: '', startSec: 2, endSec: 2 }, span('s2', 2.1, 4, 'Three four')]
    const words: [number, number][] = [
      [0, 0.9],
      [1, 2],
      [2.1, 3],
      [3.1, 4],
    ]
    const t = timeline(lane, spans, words)
    expect(placeWords(voicePieces(lane, spans), words)).toEqual([
      [0, 0.9],
      [1, 2],
      [7, 7.9],
      [8, 8.9],
    ])
    expect(t.lines.map((l) => [l.text, l.startSec, l.endSec])).toEqual([
      ['One two', 0, 2],
      ['Three four', 7, 8.9],
    ])
    const captions = captionLines(t.lines, t.words)
    expect(captions[captions.length - 1].startSec).toBeCloseTo(7, 6)
    // The duck holds over the placed words and releases through the silent shot.
    const lastDuckRegion = t.audio.duck.filter((p) => p.db < 0)
    expect(lastDuckRegion.some((p) => p.t >= 7)).toBe(true)
    expect(t.audio.duck.some((p) => p.db < 0 && p.t > 2.5 && p.t < 6.9)).toBe(false)
    expect(t.audio.voice!.pieces).toHaveLength(2)
  })

  test('the export graph places each piece on the film with one voice input when the order matches', () => {
    const t = timeline(shots([3, 4, 3]), [span('s0', 0, 2, 'One two'), span('s2', 2.1, 4, 'Three four')], [])
    const settings = resolveExportSettings({}, { hasVoiceover: true, aspectRatio: '9:16' })
    const plan = buildRenderPlan(t, settings, { size: { width: 180, height: 320 }, fps: 30, crf: 28, upscale: 1 })
    expect(voiceInputCount(plan)).toBe(1)
    const graph = audioGraph(plan, [0], null)
    expect(graph).toContain("aselect='gte(t,0)*lt(t,2)+gte(t,2.1)*lt(t,4)'")
    expect(graph).toContain('(T-2.1+7)')
    expect(graph).toContain('aresample=48000:async=1')
    expect(graph).not.toContain('asplit')
  })

  test('shots reordered against the voiceover read in more than one forward run, one input each', () => {
    expect(
      voiceRuns([
        { shotId: 'b', fromSec: 2, toSec: 3, atSec: 0 },
        { shotId: 'a', fromSec: 0, toSec: 1, atSec: 1 },
      ])
    ).toHaveLength(2)
  })

  test('a real ffmpeg render places the voice per shot: silence through the silent shot', async () => {
    const bin = ffmpegPath()
    test.skip(!bin || !existsSync(bin), 'ffmpeg-static binary unavailable')
    const dir = await mkdtemp(path.join(os.tmpdir(), 'voice-pieces-'))
    try {
      const tone = path.join(dir, 'voice.wav')
      await runFfmpeg(bin!, ['-f', 'lavfi', '-i', 'sine=frequency=440:duration=4', '-ar', '48000', tone])
      // Speech 0-2s on shot 0 (3s), shot 1 silent (4s), speech 2.1-4s on shot 2 at 7s.
      const t = timeline(shots([3, 4, 3]), [span('s0', 0, 2, 'One two'), span('s2', 2.1, 4, 'Three four')], [], 4)
      const settings = resolveExportSettings({}, { hasVoiceover: true, aspectRatio: '9:16' })
      const plan = buildRenderPlan(t, settings, { size: { width: 180, height: 320 }, fps: 30, crf: 28, upscale: 1 })
      const out = path.join(dir, 'voice-out.wav')
      await runFfmpeg(bin!, ['-i', tone, '-filter_complex', audioGraph(plan, [0], null), '-map', '[amix]', out])
      const { stderr } = await runFfmpeg(bin!, ['-i', out, '-af', 'silencedetect=n=-40dB:d=0.5', '-f', 'null', '-'])
      const starts = [...stderr.matchAll(/silence_start: ([\d.]+)/g)].map((m) => Number(m[1]))
      const ends = [...stderr.matchAll(/silence_end: ([\d.]+)/g)].map((m) => Number(m[1]))
      // One silence from the end of the first piece (~2s) to the second piece (~7s).
      expect(starts[0]).toBeGreaterThan(1.9)
      expect(starts[0]).toBeLessThan(2.2)
      expect(ends[0]).toBeGreaterThan(6.9)
      expect(ends[0]).toBeLessThan(7.1)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
