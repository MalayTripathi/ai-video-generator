const isProduction = process.env.NODE_ENV === 'production'

export type ModelsConfig = {
  script: {
    provider: 'anthropic'
    model: string
    maxTokens: number
    /** Rough USD estimate per script generation, for surfacing spend in the UI. */
    estimatedCostUsd: number
  }
  // Future steps (voiceover, image, video) each get their own section here
  // as they're implemented - keep this type and the object below in sync.
}

export const modelsConfig: ModelsConfig = {
  script: {
    provider: 'anthropic',
    model:
      process.env.CLAUDE_SCRIPT_MODEL ??
      (isProduction ? 'claude-sonnet-5' : 'claude-haiku-4-5-20251001'),
    maxTokens: Number(process.env.CLAUDE_SCRIPT_MAX_TOKENS) || 8192,
    estimatedCostUsd: 0.05,
  },
}
