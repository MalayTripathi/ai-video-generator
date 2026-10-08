import { test, expect } from '@playwright/test'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import sharp from 'sharp'
import { buildFilmTimeline } from '../src/lib/storyboard/film'
import { toFilmInput } from '../src/lib/export/film-input'
import { buildRenderPlan } from '../src/lib/export/render-plan'
import { resolveExportSettings } from '../src/lib/export/settings'
import { ffmpegPath, FONTS_DIR } from '../worker/config'
import { probe, runFfmpeg } from '../worker/ffmpeg'
import { renderExport } from '../worker/render'

// Worker integration: a real ffmpeg render of a fixture built entirely in-test - two
// solid-colour stills (sharp), 2s per shot, a 3s generated tone as the voiceover with fake
// word timings - at a tiny resolution. Never touches project data, storage or the database.
// Skipped only when the ffmpeg-static binary is unavailable.

const bin = ffmpegPath()
test.skip(!bin || !existsSync(bin), 'ffmpeg-static binary unavailable')
test.setTimeout(120_000)

test('renders the film at the asked size and length, with an audio stream, captions and chapters', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'export-render-'))
  try {
    await sharp({ create: { width: 360, height: 640, channels: 3, background: '#c0392b' } }).png().toFile(path.join(dir, 'a.png'))
    await sharp({ create: { width: 360, height: 640, channels: 3, background: '#2980b9' } }).png().toFile(path.join(dir, 'b.png'))
    const voice = path.join(dir, 'voice.m4a')
    await runFfmpeg(bin!, ['-f', 'lavfi', '-i', 'sine=frequency=440:duration=3', '-c:a', 'aac', voice])

    const shots = [
      { id: 's1', order_index: 0, duration_sec: 2, section_label: 'Opening', image_path: 'a' },
      { id: 's2', order_index: 1, duration_sec: 2, section_label: 'Close', image_path: 'b', motion: 'pan_left' },
    ]
    const read = {
      audioPath: 'voice',
      durationSec: 3,
      muted: false,
      spans: [
        { shotId: 's1', from: 0, to: 11, text: 'Hello there', startSec: 0.1, endSec: 1.0 },
        { shotId: 's2', from: 12, to: 27, text: '[warmly] friend', startSec: 2.3, endSec: 2.9 },
      ],
      words: [
        [0.1, 0.5],
        [0.6, 1.0],
        [2.3, 2.5],
        [2.5, 2.9],
      ] as [number, number][],
    }
    const noMix = { mix_voice_gain_db: null, mix_music_gain_db: null, mix_duck_depth_db: null, mix_duck_bypass: null, music_muted: null }
    const stored = { caption_mode: 'both' }
    const timeline = buildFilmTimeline(toFilmInput({ aspectRatio: '9:16', shots, read, music: null, mix: noMix, settings: stored }))
    const settings = resolveExportSettings(stored, { hasVoiceover: true, aspectRatio: '9:16' })
    const plan = buildRenderPlan(timeline, settings, { size: { width: 180, height: 320 }, fps: 30, crf: 28, upscale: 2 })
    // The join at 2.0s falls between words, so it dissolves.
    expect(plan.joinFrames[0]).toBeGreaterThan(0)

    const progress: number[] = []
    const out = await renderExport({
      plan,
      inputs: { images: new Map([['a', path.join(dir, 'a.png')], ['b', path.join(dir, 'b.png')]]), voice, music: null },
      workDir: dir,
      ffmpeg: bin!,
      fontsDir: existsSync(FONTS_DIR) ? FONTS_DIR : null,
      onProgress: (f) => progress.push(f),
    })

    const probed = await probe(bin!, out.mp4)
    expect(probed.width).toBe(180)
    expect(probed.height).toBe(320)
    expect(Math.abs(probed.durationSec! - 4)).toBeLessThanOrEqual(0.1)
    expect(probed.hasAudio).toBe(true)
    expect(progress.at(-1)).toBe(1)

    expect(await readFile(out.srt!, 'utf8')).toContain('00:00:00,100 --> 00:00:01,000\nHello there')
    expect(await readFile(out.chaptersTxt!, 'utf8')).toBe('0:00 Opening\n0:02 Close\n')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

// Music (Storyboard D): a 1.5s tone under a 4s picture. Looped, it still sounds at 3s;
// unlooped it has faded out by then. Read with ffmpeg's volumedetect on the rendered file.
test('renders the music bed looped to fit, and leaves it out past its end when not looped', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'export-render-music-'))
  try {
    await sharp({ create: { width: 360, height: 640, channels: 3, background: '#27ae60' } }).png().toFile(path.join(dir, 'a.png'))
    const music = path.join(dir, 'music.m4a')
    await runFfmpeg(bin!, ['-f', 'lavfi', '-i', 'sine=frequency=220:duration=1.5', '-c:a', 'aac', music])
    const shots = [
      { id: 's1', order_index: 0, duration_sec: 2, section_label: null, image_path: 'a' },
      { id: 's2', order_index: 1, duration_sec: 2, section_label: null, image_path: 'a' },
    ]
    const noMix = { mix_voice_gain_db: null, mix_music_gain_db: 0, mix_duck_depth_db: null, mix_duck_bypass: null }
    const settings = resolveExportSettings({}, { hasVoiceover: false, aspectRatio: '9:16' })

    async function renderWith(loop: boolean) {
      const timeline = buildFilmTimeline(
        toFilmInput({
          aspectRatio: '9:16',
          shots,
          read: null,
          music: { path: 'music', durationSec: 1.5, loop, muted: false },
          mix: noMix,
          settings: {},
        })
      )
      const plan = buildRenderPlan(timeline, settings, { size: { width: 180, height: 320 }, fps: 30, crf: 28, upscale: 2 })
      const workDir = path.join(dir, loop ? 'looped' : 'plain')
      await mkdir(workDir, { recursive: true })
      const out = await renderExport({
        plan,
        inputs: { images: new Map([['a', path.join(dir, 'a.png')]]), voice: null, music },
        workDir,
        ffmpeg: bin!,
        fontsDir: null,
        onProgress: () => {},
      })
      const probed = await probe(bin!, out.mp4)
      expect(probed.hasAudio).toBe(true)
      expect(Math.abs(probed.durationSec! - 4)).toBeLessThanOrEqual(0.1)
      const { stderr } = await runFfmpeg(bin!, ['-ss', '2.9', '-t', '0.4', '-i', out.mp4, '-af', 'volumedetect', '-vn', '-f', 'null', '-'])
      const mean = /mean_volume: (-?[\d.]+|-inf) dB/.exec(stderr)?.[1]
      return mean === undefined || mean === '-inf' ? -Infinity : Number(mean)
    }

    expect(await renderWith(true)).toBeGreaterThan(-45)
    expect(await renderWith(false)).toBeLessThan(-60)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
