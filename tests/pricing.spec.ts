import { test, expect } from '@playwright/test'
import { computeCost, ELEVENLABS_ALIGNMENT_MODEL, ELEVENLABS_RATES } from '../src/lib/config/pricing'

test.describe('computeCost', () => {
  test('anthropic: computes cost from input/output tokens at the model rate', () => {
    // claude-haiku-4-5-20251001: inputPerMTok 1.0, outputPerMTok 5.0
    const result = computeCost('anthropic', 'claude-haiku-4-5-20251001', {
      input_tokens: 1_000_000,
      output_tokens: 1_000_000,
    })
    expect(result.estimatedCost).toBeCloseTo(1.0 + 5.0, 6)
    expect(result.quantity).toBe(2_000_000)
    expect(result.unit).toBe('tokens')
    expect(result.appliedRates).not.toBeNull()
  })

  test('anthropic: includes cache_creation and cache_read buckets', () => {
    // claude-sonnet-5: inputPerMTok 2.0, outputPerMTok 10.0, cacheWritePerMTok 2.5, cacheReadPerMTok 0.2
    const result = computeCost('anthropic', 'claude-sonnet-5', {
      input_tokens: 500_000,
      output_tokens: 200_000,
      cache_creation_input_tokens: 100_000,
      cache_read_input_tokens: 1_000_000,
    })
    const expected = 500_000 * (2.0 / 1_000_000) + 200_000 * (10.0 / 1_000_000) + 100_000 * (2.5 / 1_000_000) + 1_000_000 * (0.2 / 1_000_000)
    expect(result.estimatedCost).toBeCloseTo(expected, 6)
    expect(result.quantity).toBe(700_000)
  })

  test('anthropic: null/undefined cache buckets are treated as zero', () => {
    const withNulls = computeCost('anthropic', 'claude-haiku-4-5-20251001', {
      input_tokens: 10,
      output_tokens: 10,
      cache_creation_input_tokens: null,
      cache_read_input_tokens: null,
    })
    const withoutFields = computeCost('anthropic', 'claude-haiku-4-5-20251001', {
      input_tokens: 10,
      output_tokens: 10,
    })
    expect(withNulls.estimatedCost).toBeCloseTo(withoutFields.estimatedCost!, 10)
  })

  test('unknown anthropic model returns a null cost, never a guess', () => {
    const result = computeCost('anthropic', 'claude-nonexistent-model', {
      input_tokens: 100,
      output_tokens: 100,
    })
    expect(result.estimatedCost).toBeNull()
    expect(result.appliedRates).toBeNull()
    expect(result.quantity).toBe(200)
  })

  test('fal calls are not metered by computeCost yet (no clip is generated), so a null cost', () => {
    const result = computeCost('fal', 'wan-3.0', {
      input_tokens: 100,
      output_tokens: 100,
    })
    expect(result.estimatedCost).toBeNull()
    expect(result.appliedRates).toBeNull()
    expect(result.unit).toBe('unknown')
  })

  test('elevenlabs text-to-speech: priced per character at the model rate', () => {
    const result = computeCost('elevenlabs', 'eleven_v3', { input_tokens: 0, output_tokens: 0, characters: 2000 })
    expect(result.estimatedCost).toBeCloseTo(2000 * ELEVENLABS_RATES.perCharacterUsd.eleven_v3, 9)
    expect(result.quantity).toBe(2000)
    expect(result.unit).toBe('characters')
  })

  test('elevenlabs forced alignment: priced per minute of audio', () => {
    const result = computeCost('elevenlabs', ELEVENLABS_ALIGNMENT_MODEL, {
      input_tokens: 0,
      output_tokens: 0,
      audio_seconds: 90,
    })
    expect(result.estimatedCost).toBeCloseTo(1.5 * ELEVENLABS_RATES.alignmentPerMinuteUsd, 9)
    expect(result.quantity).toBe(90)
    expect(result.unit).toBe('seconds')
  })

  test('elevenlabs music: per minute of the requested length, keyed by model', () => {
    const result = computeCost('elevenlabs', 'music_v1', { input_tokens: 0, output_tokens: 0, audio_seconds: 90 })
    expect(result.unit).toBe('seconds')
    expect(result.quantity).toBe(90)
    expect(result.estimatedCost).toBeCloseTo(1.5 * ELEVENLABS_RATES.musicPerMinuteUsd.music_v1, 9)
  })

  test('elevenlabs: an unknown text-to-speech model returns a null cost', () => {
    const result = computeCost('elevenlabs', 'not-a-model', { input_tokens: 0, output_tokens: 0, characters: 10 })
    expect(result.estimatedCost).toBeNull()
  })

  test('openai: computes cost from input/output tokens at the model rate', () => {
    // gpt-image-2.5-flare: textInputPerMTok 5.0, outputPerMTok 30.0
    const result = computeCost('openai', 'gpt-image-2.5-flare', {
      input_tokens: 1_000_000,
      output_tokens: 1_000_000,
    })
    expect(result.estimatedCost).toBeCloseTo(5.0 + 30.0, 6)
    expect(result.quantity).toBe(2_000_000)
    expect(result.unit).toBe('tokens')
    expect(result.appliedRates).not.toBeNull()
  })

  // Reference images passed to the edit endpoint arrive inside input_tokens; their share
  // (image_input_tokens) is billed at the image-input rate, the rest at the text rate.
  test('openai: image input is split out and billed at the image-input rate', () => {
    // gpt-image-2.5-flare: text 5.0, image input 8.0, output 30.0 per 1M
    const result = computeCost('openai', 'gpt-image-2.5-flare', {
      input_tokens: 3_000_000,
      image_input_tokens: 2_000_000,
      output_tokens: 1_000_000,
    })
    expect(result.estimatedCost).toBeCloseTo(1 * 5.0 + 2 * 8.0 + 1 * 30.0, 6)
  })

  test('openai: gpt-image-2 is priced at its own rates', () => {
    const result = computeCost('openai', 'gpt-image-2', { input_tokens: 3_000_000, image_input_tokens: 2_000_000, output_tokens: 1_000_000 })
    expect(result.estimatedCost).toBeCloseTo(1 * 5.0 + 2 * 8.0 + 1 * 30.0, 6)
  })

  test('openai: only registry image models are priced - sunburst, never registered, is not', () => {
    expect(computeCost('openai', 'gpt-image-2.5-sunburst', { input_tokens: 1, output_tokens: 1 }).estimatedCost).toBeNull()
  })

  test('an unrecognized openai model returns a null cost, never a guess', () => {
    // gpt-image-1-mini (shut down 1 Dec 2026) no longer has an OPENAI_RATES entry - it must
    // behave as "unrecognized," never be priced at another model's rate.
    const result = computeCost('openai', 'gpt-image-1-mini', {
      input_tokens: 100,
      output_tokens: 100,
    })
    expect(result.estimatedCost).toBeNull()
    expect(result.appliedRates).toBeNull()
    expect(result.quantity).toBe(200)
  })
})

test.describe('computeCost: Claude Haiku 5.5 two rate cards', () => {
  // https://platform.claude.com/docs/en/about-claude/pricing - up to 100,000 prompt tokens:
  // in 0.10 / 5m write 0.125 / read 0.01 / out 0.50; over it: 0.50 / 0.625 / 0.05 / 2.50.
  test('a prompt up to 100,000 tokens is priced on the standard card', () => {
    const result = computeCost('anthropic', 'claude-haiku-5-5', {
      input_tokens: 50_000,
      output_tokens: 10_000,
      cache_creation_input_tokens: 20_000,
      cache_read_input_tokens: 30_000,
    })
    // Exactly 100,000 prompt tokens: still standard ("up to 100,000").
    expect(result.estimatedCost).toBeCloseTo(0.05 * 0.1 + 0.01 * 0.5 + 0.02 * 0.125 + 0.03 * 0.01, 9)
    expect(result.appliedRates).toMatchObject({ tier: 'standard', inputPerMTok: 0.1, outputPerMTok: 0.5 })
  })

  test('cache reads and writes count toward the threshold: one token over prices every bucket on the long card', () => {
    const result = computeCost('anthropic', 'claude-haiku-5-5', {
      input_tokens: 50_001,
      output_tokens: 10_000,
      cache_creation_input_tokens: 20_000,
      cache_read_input_tokens: 30_000,
    })
    expect(result.estimatedCost).toBeCloseTo(0.050001 * 0.5 + 0.01 * 2.5 + 0.02 * 0.625 + 0.03 * 0.05, 9)
    expect(result.appliedRates).toMatchObject({
      tier: 'long_context',
      inputPerMTok: 0.5,
      outputPerMTok: 2.5,
      cacheWritePerMTok: 0.625,
      cacheReadPerMTok: 0.05,
    })
  })

  test('Haiku 4.5 rows keep their single card', () => {
    const result = computeCost('anthropic', 'claude-haiku-4-5-20251001', { input_tokens: 200_000, output_tokens: 0 })
    expect(result.estimatedCost).toBeCloseTo(0.2, 9)
    expect(result.appliedRates).toMatchObject({ tier: 'standard', inputPerMTok: 1.0 })
  })
})
