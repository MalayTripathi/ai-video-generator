import { test, expect } from '@playwright/test'
import { admin } from './supabase-test-session'
import {
  QUALITY_PRESETS,
  UnknownVideoModelError,
  VIDEO_MODELS,
  VIDEO_MODEL_IDS,
  assertRegisteredVideoModel,
  isDurationAllowed,
  isRegisteredVideoModel,
  videoModelBounds,
  type VideoModelId,
} from '../src/lib/config/models'
import { videoUsdPerSecond } from '../src/lib/config/pricing'
import { videoModelChipLabel } from '../src/components/workbench/project-header'

// The video-model registry (models.ts) against the values sourced from each model's fal
// pages. A changed value here should be a changed source, re-checked - never a typo fix.

type Expected = {
  bounds: { min: number; max: number }
  discrete: number[] | null
  resolutions: string[] | null
  audio: 'generated' | 'input_only' | 'none'
  references: boolean
  /** [resolution, audio, USD per second] */
  prices: [string, boolean, number][]
}

const EXPECTED: Record<VideoModelId, Expected> = {
  'seedance-1.0-pro': {
    bounds: { min: 2, max: 12 },
    discrete: null,
    resolutions: ['480p', '720p', '1080p'],
    audio: 'none',
    references: false,
    prices: [
      ['480p', false, 0.0243],
      ['720p', false, 0.054],
      ['1080p', false, 0.1215],
    ],
  },
  'seedance-2.0-mini': {
    bounds: { min: 4, max: 15 },
    discrete: null,
    resolutions: ['480p', '720p'],
    audio: 'generated',
    references: false,
    prices: [
      ['480p', false, 0.0721],
      ['480p', true, 0.0721],
      ['720p', false, 0.1547],
      ['720p', true, 0.1547],
    ],
  },
  'seedance-2.0-fast': {
    bounds: { min: 4, max: 15 },
    discrete: null,
    resolutions: ['480p', '720p'],
    audio: 'generated',
    references: false,
    prices: [
      ['480p', true, 0.1089],
      ['720p', true, 0.2419],
    ],
  },
  'wan-2.5': {
    bounds: { min: 5, max: 10 },
    discrete: [5, 10],
    resolutions: ['480p', '720p', '1080p'],
    audio: 'input_only',
    references: false,
    prices: [
      ['480p', false, 0.05],
      ['720p', false, 0.1],
      ['1080p', false, 0.15],
    ],
  },
  'wan-3.0': {
    bounds: { min: 2, max: 30 },
    discrete: null,
    resolutions: ['480p', '720p', '1080p'],
    audio: 'generated',
    references: false,
    prices: [
      ['480p', false, 0.05],
      ['720p', true, 0.1],
      ['1080p', false, 0.2],
    ],
  },
  'kling-v3-standard': {
    bounds: { min: 3, max: 15 },
    discrete: null,
    resolutions: null,
    audio: 'generated',
    references: true,
    prices: [
      ['720p', false, 0.084],
      ['720p', true, 0.126],
    ],
  },
}

test.describe('video model registry', () => {
  test('holds exactly the six image-to-video models', () => {
    expect(Object.keys(VIDEO_MODELS).sort()).toEqual([...VIDEO_MODEL_IDS].sort())
    expect(Object.keys(EXPECTED).sort()).toEqual([...VIDEO_MODEL_IDS].sort())
  })

  for (const id of VIDEO_MODEL_IDS) {
    test(`${id}: durations, resolutions, audio, references and price match its source`, () => {
      const config = VIDEO_MODELS[id]
      const want = EXPECTED[id]
      expect(config.id).toBe(id)
      expect(videoModelBounds(config)).toEqual(want.bounds)
      if (want.discrete) {
        expect(config.kind).toBe('discrete')
        for (const s of want.discrete) expect(isDurationAllowed(config, s)).toBe(true)
        expect(isDurationAllowed(config, 7)).toBe(false)
      } else {
        expect(config.kind).toBe('continuous')
        expect(isDurationAllowed(config, want.bounds.min)).toBe(true)
        expect(isDurationAllowed(config, want.bounds.max)).toBe(true)
        expect(isDurationAllowed(config, want.bounds.max + 1)).toBe(false)
        expect(isDurationAllowed(config, want.bounds.min - 1)).toBe(false)
        // fal takes whole seconds only: a fractional length inside the range is refused.
        expect(config.kind === 'continuous' && config.durationStep).toBe(1)
        expect(isDurationAllowed(config, want.bounds.min + 0.5)).toBe(false)
      }
      expect(config.resolutions === null ? null : [...config.resolutions]).toEqual(want.resolutions)
      expect(config.audio.mode).toBe(want.audio)
      expect(config.references.supported).toBe(want.references)
      for (const [resolution, audio, usd] of want.prices) {
        expect(videoUsdPerSecond({ model: id, resolution: resolution as '480p', audio })).toBe(usd)
      }
    })
  }

  test('every model records its source pages', () => {
    for (const config of Object.values(VIDEO_MODELS)) {
      expect(config.source.length, `${config.id} has no source URL`).toBeGreaterThan(0)
      for (const url of config.source) {
        expect(url, `${config.id} source`).toMatch(/^https:\/\//)
        expect(url).toContain(config.endpoint)
      }
    }
  })

  test('kling records no element limit (the schema sets none) and audio that changes the price', () => {
    const kling = VIDEO_MODELS['kling-v3-standard']
    expect(kling.references).toEqual({ supported: true, field: 'elements', maxCount: null, imagesPerReference: 4 })
    expect(kling.audio).toEqual({ mode: 'generated', flag: 'generate_audio', priceImpact: 'priced' })
  })

  test("wan 3.0's audio flag is `audio` and its price impact is recorded as unknown", () => {
    expect(VIDEO_MODELS['wan-3.0'].audio).toEqual({ mode: 'generated', flag: 'audio', priceImpact: 'unknown' })
  })
})

test.describe('quality presets', () => {
  test('low, medium, high map to the settled model / resolution / image quality / image model', () => {
    expect(QUALITY_PRESETS).toEqual({
      low: { videoModel: 'wan-3.0', videoResolution: '480p', imageQuality: 'low', imageModel: 'gpt-image-2.5-flare' },
      medium: { videoModel: 'seedance-2.0-mini', videoResolution: '720p', imageQuality: 'medium', imageModel: 'gpt-image-2.5-flare' },
      high: { videoModel: 'wan-3.0', videoResolution: '1080p', imageQuality: 'high', imageModel: 'gpt-image-2.5-flare' },
    })
  })

  test('are ordered by cost, and every preset is a combination its model offers', () => {
    const perSecond = (['low', 'medium', 'high'] as const).map((id) => {
      const p = QUALITY_PRESETS[id]
      return videoUsdPerSecond({ model: p.videoModel, resolution: p.videoResolution, audio: false })
    })
    expect(perSecond).toEqual([...perSecond].sort((a, b) => a - b))
    expect(new Set(perSecond).size).toBe(3)
  })
})

test.describe('video_model is validated in the application', () => {
  test('an unknown model fails loudly on write', () => {
    expect(() => assertRegisteredVideoModel('mochi-1')).toThrow(UnknownVideoModelError)
    expect(() => assertRegisteredVideoModel('Kling 2.1')).toThrow(UnknownVideoModelError)
    expect(assertRegisteredVideoModel('wan-3.0')).toBe('wan-3.0')
  })

  test('after the backfill, no project holds an unregistered video_model', async () => {
    const { data, error } = await admin.from('projects').select('video_model').not('video_model', 'is', null)
    expect(error).toBeNull()
    const unregistered = [...new Set((data ?? []).map((r) => r.video_model as string))].filter(
      (m) => !isRegisteredVideoModel(m)
    )
    expect(unregistered).toEqual([])
  })
})

test.describe('header model chip', () => {
  test('shows the registry label, the longest shot and the resolution for each preset', () => {
    expect(videoModelChipLabel(QUALITY_PRESETS.low.videoModel, QUALITY_PRESETS.low.videoResolution)).toBe(
      'Wan 3.0 · up to 30s/shot · 480p'
    )
    expect(videoModelChipLabel(QUALITY_PRESETS.medium.videoModel, QUALITY_PRESETS.medium.videoResolution)).toBe(
      'Seedance 2.0 Mini · up to 15s/shot · 720p'
    )
    expect(videoModelChipLabel(QUALITY_PRESETS.high.videoModel, QUALITY_PRESETS.high.videoResolution)).toBe(
      'Wan 3.0 · up to 30s/shot · 1080p'
    )
  })

  test('leaves off a resolution the model does not offer', () => {
    expect(videoModelChipLabel('kling-v3-standard', '480p')).toBe('Kling 3 Standard · up to 15s/shot')
    expect(videoModelChipLabel('seedance-2.0-mini', '1080p')).toBe('Seedance 2.0 Mini · up to 15s/shot')
  })

  test('an unknown or missing value never renders raw', () => {
    expect(videoModelChipLabel('Kling 2.1', '480p')).toBeNull()
    expect(videoModelChipLabel('fal-ai/wan-25-preview/image-to-video', '480p')).toBeNull()
    expect(videoModelChipLabel(null, '480p')).toBeNull()
  })
})
