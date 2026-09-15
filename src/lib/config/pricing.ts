import type { Provider } from '@/lib/config/pipeline'

// Single place edited when a rate changes. Bump by hand on any edit below -
// raw_usage.rates on every settled `usage` row records the rate_version that
// produced it, so a past row's cost stays reconstructable even after rates move.
export const RATE_VERSION = '2026-09-13'

// Anthropic injects a fixed system-prompt overhead when tools are present, on top of
// the tool schema JSON and the visible system/user text - this approximates that
// overhead in tokens. Not derived from a measurement yet (a few hundred tokens is the
// right order of magnitude); refine once there's a measured baseline (see CLAUDE.md).
export const TOOL_USE_SYSTEM_OVERHEAD_TOKENS = 300

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
//
// Authority: https://platform.claude.com/docs/en/about-claude/pricing. As of this
// writing, several third-party pricing trackers still show Sonnet 5 at the old
// $3/$15 figure - the docs above are correct and supersede them.
const CLAUDE_RATES: Record<string, ClaudeRates> = {
  'claude-sonnet-5': {
    inputPerMTok: 2.0,
    outputPerMTok: 10.0,
    cacheWritePerMTok: 2.5,
    cacheReadPerMTok: 0.2,
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

// elevenlabs/fal below are stub shapes only - no values yet, and computeCost returns a
// null estimatedCost for both until they're filled in.

// OpenAI meters image generation as tokens, not a flat per-image fee: a given size is a
// fixed output-token count per quality tier, times the model's output-token rate. Keyed
// by OpenAI image model (not just size/quality) so a second image model's rates can
// never collide with gpt-image-1-mini's in the same size/quality keys. Authority:
// https://platform.openai.com/docs/pricing - image-input token rates are deliberately
// omitted below, since this product never uploads an image for editing at the
// workbench step. computeCost's `openai` branch reads textInputPerMTok/outputPerMTok
// directly; outputTokensBySize is consumed by quoteOpenAiImageCall (usage/quote.ts) for
// the pre-flight quote, not by computeCost.
type OpenAiImageRates = {
  images: Record<
    string,
    {
      /** USD per 1M text input (prompt) tokens. */
      textInputPerMTok: number
      /** USD per 1M output (generated image) tokens. */
      outputPerMTok: number
      /** Fixed output-token count, keyed by size (e.g. '1024x1024') then quality (e.g. 'low'). */
      outputTokensBySize: Record<string, Record<string, number>>
    }
  >
}
export const OPENAI_RATES: OpenAiImageRates = {
  images: {
    'gpt-image-1-mini': {
      textInputPerMTok: 2.0,
      outputPerMTok: 8.0,
      outputTokensBySize: {
        '1024x1024': { low: 272, medium: 1056, high: 4160 },
      },
    },
  },
}

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

type OpenAiImageAppliedRates = { textInputPerMTok: number; outputPerMTok: number }

export type CostResult = {
  estimatedCost: number | null
  appliedRates: ClaudeRates | OpenAiImageAppliedRates | null
  quantity: number
  unit: 'tokens' | 'unknown'
}

/**
 * The single place a cost or credit number is computed from a provider's raw usage
 * report. Returns a null estimatedCost (never a guess) for an unknown model or a
 * provider with no rates configured yet (elevenlabs/fal - see the stubs above).
 */
export function computeCost(provider: Provider, model: string, breakdown: UsageBreakdown): CostResult {
  if (provider === 'openai') {
    const quantity = breakdown.input_tokens + breakdown.output_tokens
    const rates = OPENAI_RATES.images[model]
    if (!rates) {
      return { estimatedCost: null, appliedRates: null, quantity, unit: 'tokens' }
    }

    const estimatedCost =
      breakdown.input_tokens * perMillionToPerToken(rates.textInputPerMTok) +
      breakdown.output_tokens * perMillionToPerToken(rates.outputPerMTok)

    return {
      estimatedCost,
      appliedRates: { textInputPerMTok: rates.textInputPerMTok, outputPerMTok: rates.outputPerMTok },
      quantity,
      unit: 'tokens',
    }
  }

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
