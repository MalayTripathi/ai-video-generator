// Claude's per-token rate cards, the one place they are edited - a leaf module (no imports)
// so env.ts can check a configured model has a rate without importing pricing.ts, which
// imports the model registry. pricing.ts costs with these and re-exports the public names.

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
// select in modelsConfig (src/lib/config/models.server.ts). Add an entry here
// whenever a new model becomes selectable. Stored per-million for
// readability; converted to per-token in exactly one place, pricing.ts's
// perMillionToPerToken, used only inside computeCost's math.
//
// Authority: https://platform.claude.com/docs/en/about-claude/pricing. As of this
// writing, several third-party pricing trackers still show Sonnet 5 at the old
// $3/$15 figure - the docs above are correct and supersede them.
// A model priced by prompt length carries a second card for prompts over its threshold.
// "Prompt length" counts every input token - regular, cache read and cache write - and each
// request is priced on its own (https://platform.claude.com/docs/en/about-claude/pricing#long-context-pricing).
export type ClaudeModelRates = ClaudeRates & { longContext?: { thresholdTokens: number; rates: ClaudeRates } }


export const CLAUDE_RATES: Record<string, ClaudeModelRates> = {
  'claude-sonnet-5': {
    inputPerMTok: 2.0,
    outputPerMTok: 10.0,
    cacheWritePerMTok: 2.5,
    cacheReadPerMTok: 0.2,
  },
  // Two cards: up to 100,000 prompt tokens, and over it. Cache writes are the 5-minute
  // rate (every breakpoint here is the default ephemeral TTL).
  'claude-haiku-5-5': {
    inputPerMTok: 0.1,
    outputPerMTok: 0.5,
    cacheWritePerMTok: 0.125,
    cacheReadPerMTok: 0.01,
    longContext: {
      thresholdTokens: 100_000,
      rates: { inputPerMTok: 0.5, outputPerMTok: 2.5, cacheWritePerMTok: 0.625, cacheReadPerMTok: 0.05 },
    },
  },
  // Kept so rows settled on it stay reconstructable.
  'claude-haiku-4-5-20251001': {
    inputPerMTok: 1.0,
    outputPerMTok: 5.0,
    cacheWritePerMTok: 1.25,
    cacheReadPerMTok: 0.1,
  },
}

/** Whether a Claude model id has a rate card here - env.ts refuses an unpriced model at boot. */
export function isPricedClaudeModel(model: string): boolean {
  return Object.hasOwn(CLAUDE_RATES, model)
}
