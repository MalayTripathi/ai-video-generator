const isProduction = process.env.NODE_ENV === 'production'

// Video-model registry: duration bounds per model, for the Step 2 duration stepper to
// clamp against once it's built. This registry will grow - adding a model is one entry
// here, not edits scattered across several places. Seconds are fractional (real clip
// durations aren't whole numbers); frame counts and provider names must never appear in
// user-facing strings - only `label` and durations in seconds are shown to users.
export type VideoModelId = 'mochi-1'

export type VideoModelConfig = {
  id: VideoModelId
  label: string
  durationMin: number
  durationMax: number
}

export const VIDEO_MODELS: Record<VideoModelId, VideoModelConfig> = {
  'mochi-1': { id: 'mochi-1', label: 'Mochi 1', durationMin: 1.4, durationMax: 5.4 },
}

export const DEFAULT_VIDEO_MODEL: VideoModelId = 'mochi-1'

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
    model: process.env.FAL_VIDEO_MODEL ?? VIDEO_MODELS[DEFAULT_VIDEO_MODEL].id,
  },
}
