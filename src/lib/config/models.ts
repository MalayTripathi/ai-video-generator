const isProduction = process.env.NODE_ENV === 'production'

// Provider selection for element reference images. A second provider (fal) can be
// added later without touching call sites - they read modelsConfig.elements.provider,
// never this env var directly.
const imageProvider: 'openai' | 'fal' =
  process.env.IMAGE_PROVIDER === 'fal' ? 'fal' : 'openai'

// Video-model registry: duration bounds per model, for the Step 2 duration stepper to
// clamp against once it's built. This registry will grow - adding a model is one entry
// here, not edits scattered across several places. Seconds are fractional (real clip
// durations aren't whole numbers); frame counts and provider names must never appear in
// user-facing strings - only `label` and durations in seconds are shown to users.
//
// Keys must be the literal string a project's `video_model` column can hold - there is
// no normalization layer between the DB value and this lookup (see
// ProjectHeader.videoModelLabel, which looks the raw column value up directly). That's
// why 'Kling 2.1' below is Title Case with a space rather than a kebab-case slug like
// 'mochi-1' - it has to match the literal value old rows were backfilled with
// (supabase/migrations/20260827105542_backfill_video_model_default.sql).
export type VideoModelId = 'mochi-1' | 'Kling 2.1'

type VideoModelBase = {
  id: VideoModelId
  label: string
}

// Duration bounds are a discriminated union, not a min/max pair with an implied
// continuous range - a model MUST say which kind it is. This exists because Kling 2.1's
// real API takes exactly 5s or 10s, not a continuous range: the old min/max-only shape
// let the 0.1s stepper produce a value (e.g. 7.3s) the provider would reject, and that
// failure wouldn't surface until Step 7 (clip generation, the most expensive step),
// after the user had already paid for everything upstream. A model can't be defined
// without picking 'continuous' or 'discrete' - there is no way to omit `kind` and fall
// back to a default the way an optional field would allow.
export type VideoModelConfig =
  | (VideoModelBase & { kind: 'continuous'; durationMin: number; durationMax: number })
  | (VideoModelBase & { kind: 'discrete'; allowedDurations: number[] })

export const VIDEO_MODELS: Record<VideoModelId, VideoModelConfig> = {
  'mochi-1': { id: 'mochi-1', label: 'Mochi 1', kind: 'continuous', durationMin: 1.4, durationMax: 5.4 },
  // Sourced from fal.ai's own API docs for fal-ai/kling-video/v2.1 (standard/pro/master
  // all agree): `duration` is a two-value enum, 5 or 10 seconds - never anything between.
  // This closes the "known gap" the old min/max-only shape left open (see CLAUDE.md).
  'Kling 2.1': { id: 'Kling 2.1', label: 'Kling 2.1', kind: 'discrete', allowedDurations: [5, 10] },
}

export const DEFAULT_VIDEO_MODEL: VideoModelId = 'mochi-1'

// Resolves a project's stored `video_model` string to its registry entry. Unlike
// ProjectHeader.videoModelLabel (which must never blank a chip for an unregistered
// value), a duration stepper needs real bounds to clamp against - silently falling back
// to another model's bounds would be exactly the kind of wrong-ceiling data error that
// could truncate a user's shot. So this fails loudly outside production (to catch a
// missing registry entry during development) and degrades to `null` in production
// (letting the caller render a disabled stepper instead of crashing the page).
export function resolveVideoModel(id: string | null): VideoModelConfig | null {
  if (!id) return null
  const config = VIDEO_MODELS[id as VideoModelId]
  if (config) return config
  if (!isProduction) {
    throw new Error(`Unrecognized video model id "${id}" is not registered in VIDEO_MODELS`)
  }
  console.error(`[models] Unrecognized video model id "${id}" - no duration bounds available`)
  return null
}

// Whether `seconds` is a value the model can actually render - a continuous model
// accepts anything inside its range, a discrete model accepts only its exact allowed
// values. A saved duration that fails this is flagged amber and never silently
// corrected (see DurationStepper) - only the person resolves it.
export function isDurationAllowed(config: VideoModelConfig, seconds: number): boolean {
  return config.kind === 'continuous'
    ? seconds >= config.durationMin && seconds <= config.durationMax
    : config.allowedDurations.includes(seconds)
}

export type ModelsConfig = {
  shots: {
    provider: 'anthropic'
    model: string
    maxTokens: number
  }
  camera: {
    provider: 'anthropic'
    model: string
    maxTokens: number
  }
  agent: {
    provider: 'anthropic'
    model: string
    maxTokens: number
  }
  elements: {
    provider: 'openai' | 'fal'
    model: string
    quality: string
    size: '1024x1024'
  }
  prompts: {
    provider: 'anthropic'
    model: string
    maxTokens: number
  }
  video: {
    provider: 'fal'
    model: string
  }
  // Future steps (storyboard) each get their own section here as they're
  // implemented - keep this type and the object below in sync.
}

export const modelsConfig: ModelsConfig = {
  shots: {
    provider: 'anthropic',
    model:
      process.env.CLAUDE_SHOTS_MODEL ??
      (isProduction ? 'claude-sonnet-5' : 'claude-haiku-4-5-20251001'),
    maxTokens: Number(process.env.CLAUDE_SHOTS_MAX_TOKENS) || 8192,
  },
  camera: {
    provider: 'anthropic',
    // Haiku PERMANENTLY, including production - a locked cost decision, not a dev
    // default like every other section's isProduction ternary. Deriving 1-3 enum
    // values from a sentence is mechanical work that never benefits from Sonnet's
    // extra quality, and this call fires on nearly every visual-description blur, so
    // the cost delta compounds across every edit of every shot. Still overridable via
    // CLAUDE_CAMERA_MODEL for ops flexibility, but the default is Haiku in both envs.
    model: process.env.CLAUDE_CAMERA_MODEL ?? 'claude-haiku-4-5-20251001',
    // Small ceiling on purpose: reserveUsage reserves the FULL max_tokens as its
    // worst-case pre-flight quote (see src/lib/usage/quote.ts). Reusing shots'/
    // prompts' ~8192-scale ceiling here would reserve roughly 25x the real cost of a
    // 1-3 enum-field answer, on every description edit.
    maxTokens: Number(process.env.CLAUDE_CAMERA_MAX_TOKENS) || 128,
  },
  agent: {
    provider: 'anthropic',
    // Creative-judgement work (CLAUDE.md rule 16 names "the agent" explicitly), so this
    // follows the prompts/shots isProduction ternary - unlike camera's permanent-Haiku
    // carve-out, which is locked because that call is purely mechanical.
    model:
      process.env.CLAUDE_AGENT_MODEL ??
      (isProduction ? 'claude-sonnet-5' : 'claude-haiku-4-5-20251001'),
    maxTokens: Number(process.env.CLAUDE_AGENT_MAX_TOKENS) || 8192,
  },
  elements: {
    // Low quality/1024x1024 is correct in both environments, permanently - like
    // camera above, this sits outside the isProduction ternary on purpose. A
    // reference image is a consistency anchor the model looks at, never a frame the
    // viewer sees, so paying for more than the cheapest tier is waste in production
    // exactly as it is in development.
    provider: imageProvider,
    // The provider decides which env var fills `model` - there is no separate
    // per-provider model field. fal isn't implemented yet (FALAI_IMAGE_MODEL is read
    // so the env var audit is complete, but nothing consumes it until a fal
    // ImageGateway branch exists).
    model:
      imageProvider === 'openai'
        ? (process.env.OPENAI_IMAGE_MODEL ?? 'gpt-image-1-mini')
        : (process.env.FALAI_IMAGE_MODEL ?? ''),
    quality: process.env.OPENAI_IMAGE_QUALITY ?? 'low',
    size: '1024x1024',
  },
  prompts: {
    provider: 'anthropic',
    model:
      process.env.CLAUDE_PROMPTS_MODEL ??
      (isProduction ? 'claude-sonnet-5' : 'claude-haiku-4-5-20251001'),
    maxTokens: Number(process.env.CLAUDE_PROMPTS_MAX_TOKENS) || 8192,
  },
  video: {
    provider: 'fal',
    model: process.env.FAL_VIDEO_MODEL ?? VIDEO_MODELS[DEFAULT_VIDEO_MODEL].id,
  },
}
