import { test, expect } from '@playwright/test'
import { computeCost } from '../src/lib/config/pricing'

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
    // claude-sonnet-5: inputPerMTok 3.0, outputPerMTok 15.0, cacheWritePerMTok 3.75, cacheReadPerMTok 0.3
    const result = computeCost('anthropic', 'claude-sonnet-5', {
      input_tokens: 500_000,
      output_tokens: 200_000,
      cache_creation_input_tokens: 100_000,
      cache_read_input_tokens: 1_000_000,
    })
    const expected = 500_000 * (3.0 / 1_000_000) + 200_000 * (15.0 / 1_000_000) + 100_000 * (3.75 / 1_000_000) + 1_000_000 * (0.3 / 1_000_000)
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

  test('a non-anthropic provider returns a null cost (stub rates, no values yet)', () => {
    const result = computeCost('openai', 'gpt-image-1', {
      input_tokens: 100,
      output_tokens: 100,
    })
    expect(result.estimatedCost).toBeNull()
    expect(result.appliedRates).toBeNull()
    expect(result.unit).toBe('unknown')
  })
})
