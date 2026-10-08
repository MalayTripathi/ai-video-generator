import type { Provider } from '@/lib/config/pipeline'
import type { VideoResolution } from '@/lib/config/enums'
import { VIDEO_MODELS, isRegisteredVideoModel, type VideoPerSecondRate } from '@/lib/config/models'

// Single place edited when a rate changes. Bump by hand on any edit below -
// raw_usage.rates on every settled `usage` row records the rate_version that
// produced it, so a past row's cost stays reconstructable even after rates move.
export const RATE_VERSION = '2026-10-08'

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
  /** OpenAI images only: the part of input_tokens that was reference-image input, billed at
   * the image-input rate. input_tokens stays the provider's total. */
  image_input_tokens?: number | null
  /** ElevenLabs text-to-speech only: characters sent (the provider bills per character). */
  characters?: number | null
  /** ElevenLabs forced alignment and music: seconds of audio aligned or generated (billed per minute). */
  audio_seconds?: number | null
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

// OpenAI meters image generation as tokens, not a flat per-image fee. Keyed by OpenAI
// image model so two models' size/quality keys can never collide. Authority:
// https://developers.openai.com/api/docs/pricing (checked 2026-09-23). computeCost's
// `openai` branch reads the three per-MTok rates; outputTokensBySize and
// imageInputTokensPerReference are consumed only by quoteOpenAiImageCall
// (usage/quote.ts) for the worst-case pre-flight quote.
type OpenAiImageRates = {
  images: Record<
    string,
    {
      /** USD per 1M text input (prompt) tokens. */
      textInputPerMTok: number
      /** USD per 1M image input (reference image) tokens. */
      imageInputPerMTok: number
      /** USD per 1M output (generated image) tokens. */
      outputPerMTok: number
      /** Output tokens per image - what an image is priced at - keyed by size then quality. */
      outputTokensBySize: Record<string, Record<string, number>>
      /** Worst-case output tokens the pre-flight quote reserves, same keys. Never below the price figure. */
      quoteOutputTokensBySize: Record<string, Record<string, number>>
      /** Image-input tokens per reference image passed to the edit endpoint. */
      imageInputTokensPerReference: number
      /** Text-input tokens each image's price allows for its prompt. */
      promptTokenAllowance: number
    }
  >
}

// Output tokens per image for the gpt-image-2.5 family. OpenAI prints no table for 2.5;
// these come from the token calculator on its image-generation guide
// (https://developers.openai.com/api/docs/guides/image-generation): quality base low 16,
// medium 24, high 48 on the long side, the short side scaled by aspect ratio,
// ceil(a x b x (2e6 + w x h) / 4e6). That formula reproduces the page's own 196-token
// default (low, 1024x1024). The image-credit price reads them.
const GPT_IMAGE_2_5_OUTPUT_TOKENS: Record<string, Record<string, number>> = {
  '1024x1024': { low: 196, medium: 439, high: 1756 },
  '1008x1792': { low: 138, medium: 320, high: 1234 },
  '1792x1008': { low: 138, medium: 320, high: 1234 },
  '1088x1088': { low: 204, medium: 459, high: 1834 },
}

// The pre-flight quote is a spend-cap reservation and must never be overrun, but OpenAI
// says real consumption "can differ" from the calculator. Until measured usage rows say
// otherwise, it reserves twice the calculator figure.
const GPT_IMAGE_2_5_QUOTE_OUTPUT_TOKENS = Object.fromEntries(
  Object.entries(GPT_IMAGE_2_5_OUTPUT_TOKENS).map(([size, byQuality]) => [
    size,
    Object.fromEntries(Object.entries(byQuality).map(([quality, tokens]) => [quality, tokens * 2])), // placeholder
  ])
)

const GPT_IMAGE_2_5_TOKENS = {
  outputTokensBySize: GPT_IMAGE_2_5_OUTPUT_TOKENS,
  quoteOutputTokensBySize: GPT_IMAGE_2_5_QUOTE_OUTPUT_TOKENS,
  imageInputTokensPerReference: 1500, // placeholder - replace with a measured figure
  // About 1,600 characters at chars/4 - twice the stored frame prompts (~800 chars). No
  // prompt length limit exists to bound it.
  promptTokenAllowance: 400, // placeholder - replace with a measured figure
}

export const OPENAI_RATES: OpenAiImageRates = {
  images: {
    'gpt-image-2.5-flare': {
      textInputPerMTok: 5.0,
      imageInputPerMTok: 8.0,
      outputPerMTok: 30.0,
      ...GPT_IMAGE_2_5_TOKENS,
    },
  },
}

// ElevenLabs bills text-to-speech per character and forced alignment per minute of
// audio. PLACEHOLDERS: $0.10 per 1K characters and $0.40 per hour are the published
// API list prices at the time of writing, not a measurement against this account's
// plan - recalibrate from real invoices before relying on them.
type ElevenLabsRates = {
  /** USD per character of text-to-speech, keyed by model id. */
  perCharacterUsd: Record<string, number>
  /** USD per minute of forced alignment. */
  alignmentPerMinuteUsd: number
  /** USD per minute of generated music, keyed by model id. */
  musicPerMinuteUsd: Record<string, number>
}
// Music PLACEHOLDER: $0.15 per minute is the published pay-as-you-go figure at the time
// of writing, applied to every music model until invoices say otherwise.
export const ELEVENLABS_RATES: ElevenLabsRates = {
  perCharacterUsd: { eleven_v3: 0.1 / 1000 },
  alignmentPerMinuteUsd: 0.4 / 60,
  musicPerMinuteUsd: { music_v1: 0.15, music_v2: 0.15, music_v2_5: 0.15 },
}

// The model name a usage row carries for a forced-alignment call - the endpoint has no
// selectable model.
export const ELEVENLABS_ALIGNMENT_MODEL = 'forced-alignment'

// fal per-second video rates, keyed by model then resolution - derived from VIDEO_MODELS
// (models.ts), the registry each figure is sourced in, never copied by hand.
// computeCost has no fal branch yet (no clip is generated anywhere); the price lives here
// for videoUsdPerSecond and the video credit price.
type FalRates = { perSecondUsd: Record<string, Partial<Record<VideoResolution | 'any', VideoPerSecondRate>>> }
export const FAL_RATES: FalRates = {
  perSecondUsd: Object.fromEntries(Object.values(VIDEO_MODELS).map((m) => [m.id, m.usdPerSecond])),
}

export class UnpricedVideoError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'UnpricedVideoError'
  }
}

/**
 * fal's USD per second for one model / resolution / audio choice. Throws for a combination
 * the model can't produce (an unregistered model, a resolution it doesn't offer, audio on a
 * model that can't generate it) - never a silent zero.
 */
export function videoUsdPerSecond(params: { model: string; resolution: VideoResolution; audio: boolean }): number {
  const { model, resolution, audio } = params
  if (!isRegisteredVideoModel(model)) throw new UnpricedVideoError(`Video model "${model}" has no fal rate.`)
  const config = VIDEO_MODELS[model]
  if (config.resolutions !== null && !config.resolutions.includes(resolution)) {
    throw new UnpricedVideoError(`${model} does not offer ${resolution}.`)
  }
  const rate = FAL_RATES.perSecondUsd[model][config.resolutions === null ? 'any' : resolution]
  if (!rate) throw new UnpricedVideoError(`${model} has no rate for ${resolution}.`)
  if (!audio) return rate.audioOff
  if (rate.audioOn === null) throw new UnpricedVideoError(`${model} cannot generate audio.`)
  return rate.audioOn
}

type ElevenLabsAppliedRates =
  | { perCharacterUsd: number }
  | { alignmentPerMinuteUsd: number }
  | { musicPerMinuteUsd: number }

type OpenAiImageAppliedRates = { textInputPerMTok: number; imageInputPerMTok: number; outputPerMTok: number }

export type CostResult = {
  estimatedCost: number | null
  appliedRates: ClaudeRates | OpenAiImageAppliedRates | ElevenLabsAppliedRates | null
  quantity: number
  unit: 'tokens' | 'characters' | 'seconds' | 'unknown'
}

/**
 * The single place a cost or credit number is computed from a provider's raw usage
 * report. Returns a null estimatedCost (never a guess) for an unknown model or a
 * provider whose calls it doesn't meter yet (fal - see FAL_RATES above).
 */
export function computeCost(provider: Provider, model: string, breakdown: UsageBreakdown): CostResult {
  if (provider === 'openai') {
    const quantity = breakdown.input_tokens + breakdown.output_tokens
    const rates = OPENAI_RATES.images[model]
    if (!rates) {
      return { estimatedCost: null, appliedRates: null, quantity, unit: 'tokens' }
    }

    // input_tokens is the provider's total; the reference-image share of it is billed at
    // the image-input rate and only the remainder at the text rate.
    const imageInputTokens = breakdown.image_input_tokens ?? 0
    const textInputTokens = breakdown.input_tokens - imageInputTokens
    const estimatedCost =
      textInputTokens * perMillionToPerToken(rates.textInputPerMTok) +
      imageInputTokens * perMillionToPerToken(rates.imageInputPerMTok) +
      breakdown.output_tokens * perMillionToPerToken(rates.outputPerMTok)

    return {
      estimatedCost,
      appliedRates: {
        textInputPerMTok: rates.textInputPerMTok,
        imageInputPerMTok: rates.imageInputPerMTok,
        outputPerMTok: rates.outputPerMTok,
      },
      quantity,
      unit: 'tokens',
    }
  }

  if (provider === 'elevenlabs') {
    // Forced alignment and music report seconds; text-to-speech reports characters.
    const musicRate = ELEVENLABS_RATES.musicPerMinuteUsd[model]
    if (musicRate !== undefined) {
      const seconds = breakdown.audio_seconds ?? 0
      return {
        estimatedCost: (seconds / 60) * musicRate,
        appliedRates: { musicPerMinuteUsd: musicRate },
        quantity: seconds,
        unit: 'seconds',
      }
    }
    if (model === ELEVENLABS_ALIGNMENT_MODEL) {
      const seconds = breakdown.audio_seconds ?? 0
      const rate = ELEVENLABS_RATES.alignmentPerMinuteUsd
      return {
        estimatedCost: (seconds / 60) * rate,
        appliedRates: { alignmentPerMinuteUsd: rate },
        quantity: seconds,
        unit: 'seconds',
      }
    }
    const characters = breakdown.characters ?? 0
    const rate = ELEVENLABS_RATES.perCharacterUsd[model]
    if (rate === undefined) {
      return { estimatedCost: null, appliedRates: null, quantity: characters, unit: 'characters' }
    }
    return { estimatedCost: characters * rate, appliedRates: { perCharacterUsd: rate }, quantity: characters, unit: 'characters' }
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
