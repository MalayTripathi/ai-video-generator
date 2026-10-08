import { test, expect } from '@playwright/test'
import { fixedCredits } from './helpers/prices'
import { STEPS, OPERATIONS } from '../src/lib/config/pipeline'
import {
  usdToCredits,
  creditsFor,
  imageCredits,
  videoClipCredits,
  MissingCreditPriceError,
  UnpricedImageError,
  PRICE_TABLE,
  CREDIT_MARGIN,
  CREDIT_PRICE_VERSION,
} from '../src/lib/config/credits'
import { OPENAI_RATES, UnpricedVideoError, videoUsdPerSecond } from '../src/lib/config/pricing'
import { IMAGE_QUALITIES, VIDEO_RESOLUTIONS } from '../src/lib/config/enums'
import { IMAGE_MODELS, VIDEO_MODELS } from '../src/lib/config/models'
import { STORYBOARD_IMAGE_SIZES } from '../src/lib/config/storyboard'

// Pure-function coverage for src/lib/config/credits.ts - no DB, no network. No
// application code reads this module yet (Task 4's concern); these tests are the
// only consumer besides pipeline.ts's types.

test.describe('usdToCredits', () => {
  const cases: Array<[number, number]> = [
    [0, 0],
    [0.0001, 1],
    [0.001, 1],
    [0.0011, 2],
    [0.014, 14],
    // Float noise is not a real excess: 0.084 x 5 = 0.42000000000000004 is 420, not 421.
    [0.084 * 5, 420],
    [0.4200011, 421],
  ]

  for (const [usd, expected] of cases) {
    test(`${usd} usd -> ${expected} credits`, async () => {
      expect(usdToCredits(usd)).toBe(expected)
    })
  }
})

test.describe('creditsFor', () => {
  test('per_shot scales with quantity', async () => {
    const one = creditsFor({ step: 'workbench', operation: 'generate_shots', quantity: 1 })
    const eight = creditsFor({ step: 'workbench', operation: 'generate_shots', quantity: 8 })
    expect(eight).toBe(one * 8)
  })

  test('per_project ignores quantity', async () => {
    const qty1 = creditsFor({ step: 'assembly', operation: 'merge', quantity: 1 })
    const qty99 = creditsFor({ step: 'assembly', operation: 'merge', quantity: 99 })
    expect(qty1).toBe(qty99)
  })

  test('per_element scales with quantity, on the image key it is given', async () => {
    const image = { model: 'gpt-image-2.5-flare', quality: 'low', size: '1024x1024', referenceCount: 0 } as const
    const one = creditsFor({ step: 'workbench', operation: 'generate_element_reference', quantity: 1, image })
    const four = creditsFor({ step: 'workbench', operation: 'generate_element_reference', quantity: 4, image })
    expect(four).toBe(one * 4)
  })

  test('an image operation without its price key throws, never prices at zero', async () => {
    for (const [step, operation] of [
      ['storyboard', 'generate_image'],
      ['workbench', 'generate_element_reference'],
    ] as const) {
      expect(() => creditsFor({ step, operation, quantity: 1 })).toThrow(MissingCreditPriceError)
    }
  })

  test('per_1k_chars rounds credits x chars / 1000 up', async () => {
    const perK = fixedCredits('storyboard', 'voiceover')
    expect(PRICE_TABLE.storyboard!.voiceover!.unit).toBe('per_1k_chars')
    expect(creditsFor({ step: 'storyboard', operation: 'voiceover', quantity: 1000 })).toBe(perK)
    expect(creditsFor({ step: 'storyboard', operation: 'voiceover', quantity: 1 })).toBe(Math.ceil(perK / 1000))
    expect(creditsFor({ step: 'storyboard', operation: 'voiceover', quantity: 1501 })).toBe(Math.ceil((perK * 1501) / 1000))
  })

  test('per_minute rounds credits x seconds / 60 up', async () => {
    const perMin = fixedCredits('storyboard', 'align_voiceover')
    expect(PRICE_TABLE.storyboard!.align_voiceover!.unit).toBe('per_minute')
    expect(creditsFor({ step: 'storyboard', operation: 'align_voiceover', quantity: 60 })).toBe(perMin)
    expect(creditsFor({ step: 'storyboard', operation: 'align_voiceover', quantity: 61 })).toBe(Math.ceil((perMin * 61) / 60))
    expect(creditsFor({ step: 'storyboard', operation: 'align_voiceover', quantity: 0.5 })).toBe(Math.ceil((perMin * 0.5) / 60))
  })

  test('throws MissingCreditPriceError for (generation, generate_clip)', async () => {
    expect(() => creditsFor({ step: 'generation', operation: 'generate_clip', quantity: 1 })).toThrow(
      MissingCreditPriceError
    )
  })

  test('throws MissingCreditPriceError for (workbench, agent_turn) - dynamic pricing not reachable here', async () => {
    expect(() => creditsFor({ step: 'workbench', operation: 'agent_turn', quantity: 1 })).toThrow(
      MissingCreditPriceError
    )
  })
})

test.describe('PRICE_TABLE membership', () => {
  test('every keyed (step, operation) pair is a real STEPS/OPERATIONS member', async () => {
    for (const step of Object.keys(PRICE_TABLE) as Array<keyof typeof PRICE_TABLE>) {
      expect(STEPS).toContain(step)
      const operations = PRICE_TABLE[step]!
      for (const operation of Object.keys(operations)) {
        expect(OPERATIONS).toContain(operation)
      }
    }
  })
})

test.describe('computed prices - images and video', () => {
  test('CREDIT_PRICE_VERSION is bumped past the hand-set image prices, and CREDIT_MARGIN is 1.0', () => {
    expect(CREDIT_PRICE_VERSION > '2026-09-25').toBe(true)
    expect(CREDIT_MARGIN).toBe(1.0)
  })

  test('no image operation carries a hand-set credit number', () => {
    for (const entry of [PRICE_TABLE.storyboard!.generate_image!, PRICE_TABLE.workbench!.generate_element_reference!]) {
      expect(entry.kind).toBe('image')
      expect(entry).not.toHaveProperty('credits')
    }
  })

  // Every model x quality x size the app sends: frames at each aspect ratio's size, element
  // references at 1024x1024. Each must equal the provider's cost, recomputed here from the
  // rates, x CREDIT_MARGIN, rounded up once.
  const sizes = [...Object.values(STORYBOARD_IMAGE_SIZES), '1024x1024']
  for (const model of Object.keys(IMAGE_MODELS)) {
    for (const quality of IMAGE_QUALITIES) {
      for (const size of sizes) {
        for (const referenceCount of [0, 2]) {
          test(`${model} ${quality} ${size} with ${referenceCount} references is computed from its rates`, () => {
            const rates = OPENAI_RATES.images[model]
            const usd =
              (rates.outputTokensBySize[size][quality] * rates.outputPerMTok +
                referenceCount * rates.imageInputTokensPerReference * rates.imageInputPerMTok +
                rates.promptTokenAllowance * rates.textInputPerMTok) /
              1_000_000
            expect(imageCredits({ model, quality, size, referenceCount })).toBe(usdToCredits(usd * CREDIT_MARGIN))
          })
        }
      }
    }
  }

  test('known image prices, worked by hand', () => {
    // Every image carries a 400-token prompt allowance at $5/1M text input: $0.002.
    // low 9:16: 138 output tokens x $30/1M = $0.00414, + $0.002 = $0.00614 -> 7 credits.
    expect(imageCredits({ model: 'gpt-image-2.5-flare', quality: 'low', size: '1008x1792', referenceCount: 0 })).toBe(7)
    // + one reference: 1500 image-input tokens x $8/1M = $0.012 -> $0.01814 -> 19 credits.
    expect(imageCredits({ model: 'gpt-image-2.5-flare', quality: 'low', size: '1008x1792', referenceCount: 1 })).toBe(19)
    // element reference, low 1024x1024: 196 x $30/1M = $0.00588, + $0.002 -> 8 credits.
    expect(imageCredits({ model: 'gpt-image-2.5-flare', quality: 'low', size: '1024x1024', referenceCount: 0 })).toBe(8)
    // high 1:1: 1834 x $30/1M = $0.05502, + $0.002 -> 58 credits.
    expect(imageCredits({ model: 'gpt-image-2.5-flare', quality: 'high', size: '1088x1088', referenceCount: 0 })).toBe(58)
  })

  test('the pre-flight quote reserves at least the priced output, so a reservation stays a ceiling', () => {
    for (const rates of Object.values(OPENAI_RATES.images)) {
      for (const [size, byQuality] of Object.entries(rates.outputTokensBySize)) {
        for (const [quality, tokens] of Object.entries(byQuality)) {
          expect(rates.quoteOutputTokensBySize[size][quality]).toBeGreaterThanOrEqual(tokens)
        }
      }
    }
  })

  test('an unpriced image model or size throws', () => {
    expect(() => imageCredits({ model: 'gpt-image-1-mini', quality: 'low', size: '1024x1024', referenceCount: 0 })).toThrow(
      UnpricedImageError
    )
    expect(() => imageCredits({ model: 'gpt-image-2.5-flare', quality: 'low', size: '512x512', referenceCount: 0 })).toThrow(
      UnpricedImageError
    )
  })

  // Every video model x resolution x audio the model can produce, priced from the registry's
  // per-second rate x seconds x CREDIT_MARGIN; combinations it can't produce throw.
  for (const config of Object.values(VIDEO_MODELS)) {
    for (const resolution of VIDEO_RESOLUTIONS) {
      for (const audio of [false, true]) {
        test(`${config.id} ${resolution} audio ${audio ? 'on' : 'off'} is computed or refused`, () => {
          const rate = config.usdPerSecond[config.resolutions === null ? 'any' : resolution]
          const offered = config.resolutions === null || config.resolutions.includes(resolution)
          const perSecond = audio ? rate?.audioOn : rate?.audioOff
          if (!offered || perSecond === null || perSecond === undefined) {
            expect(() => videoClipCredits({ model: config.id, resolution, audio, seconds: 5 })).toThrow(UnpricedVideoError)
            return
          }
          expect(videoUsdPerSecond({ model: config.id, resolution, audio })).toBe(perSecond)
          expect(videoClipCredits({ model: config.id, resolution, audio, seconds: 5 })).toBe(
            usdToCredits(perSecond * 5 * CREDIT_MARGIN)
          )
        })
      }
    }
  }

  test('known clip prices, worked by hand', () => {
    // Wan 3.0, 480p, 5s: $0.05/s -> $0.25 -> 250 credits.
    expect(videoClipCredits({ model: 'wan-3.0', resolution: '480p', audio: false, seconds: 5 })).toBe(250)
    // Kling 3 Standard: audio changes the price - $0.084/s off, $0.126/s on.
    expect(videoClipCredits({ model: 'kling-v3-standard', resolution: '720p', audio: false, seconds: 5 })).toBe(420)
    expect(videoClipCredits({ model: 'kling-v3-standard', resolution: '720p', audio: true, seconds: 5 })).toBe(630)
    expect(() => videoClipCredits({ model: 'mochi-1', resolution: '480p', audio: false, seconds: 5 })).toThrow(UnpricedVideoError)
  })
})
