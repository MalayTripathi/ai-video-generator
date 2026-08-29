const isProduction = process.env.NODE_ENV === 'production'

export type ModelsConfig = {
  prompts: {
    provider: 'anthropic'
    model: string
    maxTokens: number
  }
  shots: {
    provider: 'anthropic'
    model: string
    maxTokens: number
  }
  video: {
    provider: 'fal'
    model: string
  }
  // Future steps (voiceover, image) each get their own section here as
  // they're implemented - keep this type and the object below in sync.
}

export const modelsConfig: ModelsConfig = {
  prompts: {
    provider: 'anthropic',
    model:
      process.env.CLAUDE_PROMPTS_MODEL ??
      (isProduction ? 'claude-sonnet-5' : 'claude-haiku-4-5-20251001'),
    maxTokens: Number(process.env.CLAUDE_PROMPTS_MAX_TOKENS) || 8192,
  },
  shots: {
    provider: 'anthropic',
    model:
      process.env.CLAUDE_SHOTS_MODEL ??
      (isProduction ? 'claude-sonnet-5' : 'claude-haiku-4-5-20251001'),
    maxTokens: Number(process.env.CLAUDE_SHOTS_MAX_TOKENS) || 8192,
  },
  video: {
    provider: 'fal',
    model: process.env.FAL_VIDEO_MODEL ?? 'Kling 2.1',
  },
}

type ClaudeRates = {
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
// select in modelsConfig above. Add an entry here whenever a new model
// becomes selectable.
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

/** Returns null for a model with no known rates, rather than guessing. */
export function estimateClaudeCostUsd(
  model: string,
  usage: {
    input_tokens: number
    output_tokens: number
    cache_creation_input_tokens?: number | null
    cache_read_input_tokens?: number | null
  }
): number | null {
  const rates = CLAUDE_RATES[model]
  if (!rates) return null

  return (
    (usage.input_tokens / 1_000_000) * rates.inputPerMTok +
    (usage.output_tokens / 1_000_000) * rates.outputPerMTok +
    ((usage.cache_creation_input_tokens ?? 0) / 1_000_000) * rates.cacheWritePerMTok +
    ((usage.cache_read_input_tokens ?? 0) / 1_000_000) * rates.cacheReadPerMTok
  )
}
