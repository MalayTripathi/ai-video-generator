import type { Provider } from '@/lib/config/pipeline'

// Single place edited when a rate changes. Bump by hand on any edit below -
// raw_usage.rates on every settled `usage` row records the rate_version that
// produced it, so a past row's cost stays reconstructable even after rates move.
export const RATE_VERSION = '2026-08-31'

export type UsageBreakdown = {
  input_tokens: number
  output_tokens: number
  cache_creation_input_tokens?: number | null
  cache_read_input_tokens?: number | null
}

export type ClaudeRates = {
  /** USD per 1M regular input tokens. */
  inputPerMTok: number
  /** USD per 1M output tokens. */
  outputPerMTok: number
  /** USD per 1M tokens written to the prompt cache (~1.25x input). */
  cacheWritePerMTok: number
  /** USD per 1M tokens read from the prompt cache (~0.1x input). */
  cacheReadPerMTok: number
}

// Standard (non-intro) per-token rates for the Claude models this app can
// select in modelsConfig (src/lib/config/models.ts). Add an entry here
// whenever a new model becomes selectable. Stored per-million for
// readability; converted to per-token in exactly one place, perMillionToPerToken,
// used only inside computeCost's math below.
const CLAUDE_RATES: Record<string, ClaudeRates> = {
  'claude-sonnet-5': {
    inputPerMTok: 3.0,
    outputPerMTok: 15.0,
    cacheWritePerMTok: 3.75,
    cacheReadPerMTok: 0.3,
  },
  'claude-haiku-4-5-20251001': {
    inputPerMTok: 1.0,
    outputPerMTok: 5.0,
    cacheWritePerMTok: 1.25,
    cacheReadPerMTok: 0.1,
  },
}

function perMillionToPerToken(ratePerMillion: number): number {
  return ratePerMillion / 1_000_000
}

// Stub shapes only - no values yet. Filling these in is what makes a new
// provider's usage/cost tracking real; until then computeCost returns a null
// estimatedCost for any provider below.

/** Keyed by size (e.g. '1024x1024'), then quality (e.g. 'standard' | 'hd'). */
type OpenAiImageRates = {
  images: Record<string, Record<string, number>>
}
export const OPENAI_RATES: OpenAiImageRates = { images: {} }

type ElevenLabsRates = {
  perCharacterUsd: number | null
}
export const ELEVENLABS_RATES: ElevenLabsRates = { perCharacterUsd: null }

/** Keyed by fal model name. A model uses exactly one of the two shapes, depending on how fal bills it. */
type FalRates = {
  perClipUsd: Record<string, number>
  perSecondUsd: Record<string, number>
}
export const FAL_RATES: FalRates = { perClipUsd: {}, perSecondUsd: {} }

export type CostResult = {
  estimatedCost: number | null
  appliedRates: ClaudeRates | null
  quantity: number
  unit: 'tokens' | 'unknown'
}

/**
 * The single place a cost or credit number is computed from a provider's raw usage
 * report. Returns a null estimatedCost (never a guess) for an unknown model or a
 * provider with no rates configured yet (openai/elevenlabs/fal - see the stubs above).
 */
export function computeCost(provider: Provider, model: string, breakdown: UsageBreakdown): CostResult {
  if (provider !== 'anthropic') {
    return { estimatedCost: null, appliedRates: null, quantity: 0, unit: 'unknown' }
  }

  const quantity = breakdown.input_tokens + breakdown.output_tokens
  const rates = CLAUDE_RATES[model]
  if (!rates) {
    return { estimatedCost: null, appliedRates: null, quantity, unit: 'tokens' }
  }

  const estimatedCost =
    breakdown.input_tokens * perMillionToPerToken(rates.inputPerMTok) +
    breakdown.output_tokens * perMillionToPerToken(rates.outputPerMTok) +
    (breakdown.cache_creation_input_tokens ?? 0) * perMillionToPerToken(rates.cacheWritePerMTok) +
    (breakdown.cache_read_input_tokens ?? 0) * perMillionToPerToken(rates.cacheReadPerMTok)

  return { estimatedCost, appliedRates: rates, quantity, unit: 'tokens' }
}
