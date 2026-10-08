const isProduction = process.env.NODE_ENV === 'production'

// Provider selection for element reference images. A second provider (fal) can be
// added later without touching call sites - they read modelsConfig.elements.provider,
// never this env var directly.
const elementImageProvider: 'openai' | 'fal' =
  process.env.ELEMENT_IMAGE_PROVIDER === 'fal' ? 'fal' : 'openai'

// Provider selection for Step 4 storyboard images - same shape as the element selector
// above, and deliberately independent of it: the two may differ in model and quality
// from day one. fal has no image gateway yet, so selecting it is refused by the images
// route before any claim (see runImagesRequest).
const storyboardImageProvider: 'openai' | 'fal' =
  process.env.STORYBOARD_IMAGE_PROVIDER === 'fal' ? 'fal' : 'openai'

// Provider selection for Step 4 voiceover. ElevenLabs is the only implementation; any
// other value is refused by the voiceover routes before a claim.
const voiceoverProvider = 'elevenlabs' as const
if (process.env.VOICEOVER_PROVIDER && process.env.VOICEOVER_PROVIDER !== 'elevenlabs') {
  console.error(`[models] VOICEOVER_PROVIDER="${process.env.VOICEOVER_PROVIDER}" is not implemented; using elevenlabs`)
}

// Provider selection for Step 4 background music - same shape as the voiceover selector.
const musicProvider = 'elevenlabs' as const
if (process.env.MUSIC_PROVIDER && process.env.MUSIC_PROVIDER !== 'elevenlabs') {
  console.error(`[models] MUSIC_PROVIDER="${process.env.MUSIC_PROVIDER}" is not implemented; using elevenlabs`)
}

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

// The longest clip a model can render - a continuous model's upper bound, a discrete
// model's longest allowed value. The Storyboard's retime ceiling reads this.
export function videoModelMaxSeconds(config: VideoModelConfig): number {
  return config.kind === 'continuous' ? config.durationMax : Math.max(...config.allowedDurations)
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
  // Size is not here: it follows the project's aspect ratio, from
  // STORYBOARD_IMAGE_SIZES (src/lib/config/storyboard.ts).
  storyboardImages: {
    provider: 'openai' | 'fal'
    model: string
    quality: string
  }
  imagePrompts: {
    provider: 'anthropic'
    model: string
    maxTokens: number
  }
  video: {
    provider: 'fal'
    model: string
  }
  // Voices are not here: they are a per-language list, VOICEOVER_VOICES below.
  voiceover: {
    provider: 'elevenlabs'
    model: string
  }
  music: {
    provider: 'elevenlabs'
    model: string
  }
  musicPrompt: {
    provider: 'anthropic'
    model: string
    maxTokens: number
  }
  // Future steps (video prompts) each get their own section here as they're
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
    provider: elementImageProvider,
    // The provider decides which env var fills `model` - there is no separate
    // per-provider model field. fal isn't implemented yet (FALAI_ELEMENT_IMAGE_MODEL
    // is read so the env var audit is complete, but nothing consumes it until a fal
    // ImageGateway branch exists).
    model:
      elementImageProvider === 'openai'
        ? (process.env.OPENAI_ELEMENT_IMAGE_MODEL ?? 'gpt-image-1-mini')
        : (process.env.FALAI_ELEMENT_IMAGE_MODEL ?? ''),
    quality: process.env.OPENAI_ELEMENT_IMAGE_QUALITY ?? 'low',
    size: '1024x1024',
  },
  storyboardImages: {
    provider: storyboardImageProvider,
    // Same provider-decides-the-env-var rule as elements. fal is config-only until a fal
    // ImageGateway branch exists.
    model:
      storyboardImageProvider === 'openai'
        ? (process.env.OPENAI_STORYBOARD_IMAGE_MODEL ?? 'gpt-image-2.5-flare')
        : (process.env.FALAI_STORYBOARD_IMAGE_MODEL ?? ''),
    quality: process.env.OPENAI_STORYBOARD_IMAGE_QUALITY ?? 'low',
  },
  imagePrompts: {
    provider: 'anthropic',
    model:
      process.env.CLAUDE_IMAGE_PROMPTS_MODEL ??
      (isProduction ? 'claude-sonnet-5' : 'claude-haiku-4-5-20251001'),
    maxTokens: Number(process.env.CLAUDE_IMAGE_PROMPTS_MAX_TOKENS) || 8192,
  },
  video: {
    provider: 'fal',
    model: process.env.FAL_VIDEO_MODEL ?? VIDEO_MODELS[DEFAULT_VIDEO_MODEL].id,
  },
  voiceover: {
    provider: voiceoverProvider,
    // eleven_v3 is required: scripts carry inline audio tags ([slowly], [warmly]) that
    // older models would read aloud as words.
    model: process.env.ELEVENLABS_VOICEOVER_MODEL ?? 'eleven_v3',
  },
  music: {
    provider: musicProvider,
    // Instrumental only - the request always sets force_instrumental.
    model: process.env.ELEVENLABS_MUSIC_MODEL ?? 'music_v1',
  },
  musicPrompt: {
    provider: 'anthropic',
    // Haiku in every environment, like camera: one short line of instruments, mood and
    // tempo is mechanical summarising, fired once per project and free to the user.
    model: process.env.CLAUDE_MUSIC_PROMPT_MODEL ?? 'claude-haiku-4-5-20251001',
    // Small ceiling for the same reason as camera: reserveUsage reserves all of it.
    maxTokens: Number(process.env.CLAUDE_MUSIC_PROMPT_MAX_TOKENS) || 128,
  },
}

// generate_element_reference's credit price (PRICE_TABLE, src/lib/config/credits.ts)
// is calibrated for gpt-image-1-mini at 'low' quality / 1024x1024 only - the price
// can't see quality (keyed on step+operation), so a quality change here would
// silently raise real provider cost while the charge stayed fixed. Fails at startup,
// in every environment - a real cost-safety bug, not a dev-only concern.
if (modelsConfig.elements.quality !== 'low') {
  throw new Error(
    `OPENAI_ELEMENT_IMAGE_QUALITY is "${modelsConfig.elements.quality}", but the ` +
      `generate_element_reference credit price is calibrated for "low" only. Update ` +
      `PRICE_TABLE (src/lib/config/credits.ts) before changing element image quality.`
  )
}

// Same guard, for storyboard/generate_image: its PRICE_TABLE entry is calibrated for
// 'low' quality only, and the price can't see quality.
if (modelsConfig.storyboardImages.quality !== 'low') {
  throw new Error(
    `OPENAI_STORYBOARD_IMAGE_QUALITY is "${modelsConfig.storyboardImages.quality}", but the ` +
      `storyboard generate_image credit price is calibrated for "low" only. Update ` +
      `PRICE_TABLE (src/lib/config/credits.ts) before changing storyboard image quality.`
  )
}

// Narration voices, four per language (two male, two female), picked by hand from the
// provider's library. The sample is the provider's own preview clip, copied once into
// public/ by scripts/fetch-voice-samples.mjs - auditioning never calls the provider.
export type VoiceoverVoice = {
  id: string
  name: string
  /** Short descriptor shown under the name, e.g. "warm · storyteller". */
  descriptor: string
  samplePath: string
}

function voice(lang: string, id: string, name: string, descriptor: string): VoiceoverVoice {
  return { id, name, descriptor, samplePath: `/voice-samples/${lang}/${id}.mp3` }
}

export const VOICEOVER_VOICES: Record<string, VoiceoverVoice[]> = {
  en: [
    voice('en', 'JBFqnCBsd6RMkjVDRZzb', 'George', 'warm · storyteller'),
    voice('en', 'nPczCjzI2devNBz1zQrb', 'Brian', 'deep · resonant'),
    voice('en', 'EXAVITQu4vr4xnSDxMaL', 'Sarah', 'mature · reassuring'),
    voice('en', 'pFZP5JQG7iQjIQuC4Bku', 'Lily', 'velvety · confident'),
  ],
  hi: [
    voice('hi', 'zgqefOY5FPQ3bB7OZTVR', 'Niraj', 'smooth · romantic'),
    voice('hi', 'Sxk6njaoa7XLsAFT7WcN', 'Amit', 'warm · sympathetic'),
    voice('hi', '1qEiC6qsybMkmnNdVMbK', 'Monika', 'calm · natural'),
    voice('hi', 'FFmp1h1BMl0iVHA0JxrI', 'Tarini', 'soft · cheerful'),
  ],
}

// The voices a project's language offers. A language with no list offers none, and
// generation is unavailable for it (upload still works).
export function voicesForLanguage(language: string | null): VoiceoverVoice[] {
  return VOICEOVER_VOICES[language ?? 'en'] ?? []
}

export function findVoice(language: string | null, voiceId: string): VoiceoverVoice | null {
  return voicesForLanguage(language).find((v) => v.id === voiceId) ?? null
}
