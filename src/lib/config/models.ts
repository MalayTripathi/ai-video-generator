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
