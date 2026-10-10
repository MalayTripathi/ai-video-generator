import { IMAGE_MODEL_IDS, IMAGE_QUALITIES, type ImageModelId, type ImageQuality, type QualityPresetId, type VideoResolution } from './enums'
import { isProduction } from './env'

// Client-safe: the image and video model registries a person picks from, and the Claude
// reasoning settings. The env-driven Claude and ElevenLabs config (modelsConfig) and the
// image dev cap are server-only, in models.server.ts.

// Video-model registry - the single source for every image-to-video model: its fal
// endpoint, duration bounds, resolutions, audio and reference support, and per-second
// price (FAL_RATES in pricing.ts is derived from `usdPerSecond` here, never hand-copied).
// Adding a model is one entry here. Frame counts, endpoints and provider names must never
// appear in user-facing strings - only `label`, `tier` and durations in seconds are shown.
//
// Keys are the literal string a project's `video_model` column holds - there is no
// normalization layer, and the column has no CHECK (models change): it is validated in
// application code against this registry (assertRegisteredVideoModel).
//
// Every value below comes from the model's own fal pages, listed in `source` (llms.txt
// for prices, the queue OpenAPI schema for parameters), checked 2026-10-08.
export const VIDEO_MODEL_IDS = [
  'seedance-1.0-pro',
  'seedance-2.0-mini',
  'seedance-2.0-fast',
  'wan-2.5',
  'wan-3.0',
  'kling-v3-standard',
] as const
export type VideoModelId = (typeof VIDEO_MODEL_IDS)[number]

export type VideoModelTier = 'Budget' | 'Standard' | 'Premium'

/** USD per second of output. `audioOn` is null when the model cannot generate audio. */
export type VideoPerSecondRate = { audioOff: number; audioOn: number | null }

type VideoModelBase = {
  id: VideoModelId
  label: string
  tier: VideoModelTier
  /** fal endpoint id. Server-side only - never rendered. */
  endpoint: string
  /** Output resolutions the request can pick; null when the provider states none. */
  resolutions: readonly VideoResolution[] | null
  audio:
    | { mode: 'generated'; flag: string; priceImpact: 'none' | 'priced' | 'unknown' }
    | { mode: 'input_only'; field: string }
    | { mode: 'none' }
  references:
    | { supported: false }
    // maxCount null = the schema sets no limit.
    | { supported: true; field: string; maxCount: number | null; imagesPerReference: number }
  /** Keyed by resolution; a model whose `resolutions` is null has a single 'any' rate. */
  usdPerSecond: Partial<Record<VideoResolution | 'any', VideoPerSecondRate>>
  source: readonly string[]
}

// Duration bounds are a discriminated union, not a min/max pair with an implied
// continuous range - a model MUST say which kind it is. A discrete model (e.g. Wan 2.5:
// exactly 5s or 10s) would otherwise let the 0.1s stepper produce a value (7.3s) the
// provider rejects, and that failure wouldn't surface until clip generation, the most
// expensive step, after the user had already paid for everything upstream.
// A range model also names its step: every fal model takes whole seconds only (a string
// enum "2".."12" or an integer), so 7.3s is as unrenderable as it is on a discrete model.
export type VideoModelConfig =
  | (VideoModelBase & { kind: 'continuous'; durationMin: number; durationMax: number; durationStep: number })
  | (VideoModelBase & { kind: 'discrete'; allowedDurations: number[] })

// Documentation links recorded as each entry's source - never requested by the app, so the
// provider-host lint rule (which guards real calls) is disabled for these two lines only.
const falSource = (endpoint: string): readonly string[] => [
  // eslint-disable-next-line no-restricted-syntax
  `https://fal.ai/models/${endpoint}/llms.txt`,
  // eslint-disable-next-line no-restricted-syntax
  `https://fal.ai/api/openapi/queue/openapi.json?endpoint_id=${endpoint}`,
]

/** Same price with or without generated audio. */
const flatAudio = (usd: number): VideoPerSecondRate => ({ audioOff: usd, audioOn: usd })
/** The model cannot generate audio. */
const silent = (usd: number): VideoPerSecondRate => ({ audioOff: usd, audioOn: null })

export const VIDEO_MODELS: Record<VideoModelId, VideoModelConfig> = {
  // Priced from the page's token formula, (h x w x fps x duration) / 1024 at $2.5 per 1M
  // tokens - not its "roughly $0.62 per 5s 1080p" headline. The page states no fps: 24 is
  // assumed, at 864x480 / 1280x720 / 1920x1080.
  'seedance-1.0-pro': {
    id: 'seedance-1.0-pro',
    label: 'Seedance 1.0 Pro',
    tier: 'Budget',
    endpoint: 'fal-ai/bytedance/seedance/v1/pro/image-to-video',
    kind: 'continuous',
    durationMin: 2,
    durationMax: 12,
    durationStep: 1,
    resolutions: ['480p', '720p', '1080p'],
    audio: { mode: 'none' },
    references: { supported: false },
    usdPerSecond: { '480p': silent(0.0243), '720p': silent(0.054), '1080p': silent(0.1215) },
    source: falSource('fal-ai/bytedance/seedance/v1/pro/image-to-video'),
  },
  // The stated 720p rate is above the page's own token formula at 1280x720 ($0.1512/s);
  // the stated (higher) rate is used.
  'seedance-2.0-mini': {
    id: 'seedance-2.0-mini',
    label: 'Seedance 2.0 Mini',
    tier: 'Standard',
    endpoint: 'bytedance/seedance-2.0/mini/image-to-video',
    kind: 'continuous',
    durationMin: 4,
    durationMax: 15,
    durationStep: 1,
    resolutions: ['480p', '720p'],
    audio: { mode: 'generated', flag: 'generate_audio', priceImpact: 'none' },
    references: { supported: false },
    usdPerSecond: { '480p': flatAudio(0.0721), '720p': flatAudio(0.1547) },
    source: falSource('bytedance/seedance-2.0/mini/image-to-video'),
  },
  // 480p is not stated: computed from the page's formula, 864x480 x 24fps / 1024 tokens
  // per second at $0.0112 per 1K tokens.
  'seedance-2.0-fast': {
    id: 'seedance-2.0-fast',
    label: 'Seedance 2.0 Fast',
    tier: 'Premium',
    endpoint: 'bytedance/seedance-2.0/fast/image-to-video',
    kind: 'continuous',
    durationMin: 4,
    durationMax: 15,
    durationStep: 1,
    resolutions: ['480p', '720p'],
    audio: { mode: 'generated', flag: 'generate_audio', priceImpact: 'none' },
    references: { supported: false },
    usdPerSecond: { '480p': flatAudio(0.1089), '720p': flatAudio(0.2419) },
    source: falSource('bytedance/seedance-2.0/fast/image-to-video'),
  },
  'wan-2.5': {
    id: 'wan-2.5',
    label: 'Wan 2.5',
    tier: 'Budget',
    endpoint: 'fal-ai/wan-25-preview/image-to-video',
    kind: 'discrete',
    allowedDurations: [5, 10],
    resolutions: ['480p', '720p', '1080p'],
    audio: { mode: 'input_only', field: 'audio_url' },
    references: { supported: false },
    usdPerSecond: { '480p': silent(0.05), '720p': silent(0.1), '1080p': silent(0.15) },
    source: falSource('fal-ai/wan-25-preview/image-to-video'),
  },
  // The audio flag is named `audio` (default on). The page's single price doesn't say
  // whether audio changes it, so the stated rate is applied to both.
  'wan-3.0': {
    id: 'wan-3.0',
    label: 'Wan 3.0',
    tier: 'Budget',
    endpoint: 'alibaba/wan-3.0/image-to-video',
    kind: 'continuous',
    durationMin: 2,
    durationMax: 30,
    durationStep: 1,
    resolutions: ['480p', '720p', '1080p'],
    audio: { mode: 'generated', flag: 'audio', priceImpact: 'unknown' },
    references: { supported: false },
    usdPerSecond: { '480p': flatAudio(0.05), '720p': flatAudio(0.1), '1080p': flatAudio(0.2) },
    source: falSource('alibaba/wan-3.0/image-to-video'),
  },
  // No resolution parameter and no stated output resolution. `elements` has no maxItems in
  // the schema; each element is one frontal image plus 1-3 reference images (field
  // description only). Voice control ($0.154/s) is not used.
  'kling-v3-standard': {
    id: 'kling-v3-standard',
    label: 'Kling 3 Standard',
    tier: 'Standard',
    endpoint: 'fal-ai/kling-video/v3/standard/image-to-video',
    kind: 'continuous',
    durationMin: 3,
    durationMax: 15,
    durationStep: 1,
    resolutions: null,
    audio: { mode: 'generated', flag: 'generate_audio', priceImpact: 'priced' },
    references: { supported: true, field: 'elements', maxCount: null, imagesPerReference: 4 },
    usdPerSecond: { any: { audioOff: 0.084, audioOn: 0.126 } },
    source: falSource('fal-ai/kling-video/v3/standard/image-to-video'),
  },
}

export class UnknownVideoModelError extends Error {
  constructor(id: string) {
    super(`Video model "${id}" is not registered in VIDEO_MODELS.`)
    this.name = 'UnknownVideoModelError'
  }
}

export function isRegisteredVideoModel(id: string | null): id is VideoModelId {
  return id !== null && Object.hasOwn(VIDEO_MODELS, id)
}

/** Every write of `projects.video_model` goes through this - an unknown value fails loudly. */
export function assertRegisteredVideoModel(id: string): VideoModelId {
  if (!isRegisteredVideoModel(id)) throw new UnknownVideoModelError(id)
  return id
}

// Resolves a project's stored `video_model` string to its registry entry. Unlike
// ProjectHeader's chip (which hides itself for an unregistered value), a duration stepper
// needs real bounds to clamp against - silently falling back to another model's bounds
// would be exactly the kind of wrong-ceiling data error that could truncate a user's shot.
// So this fails loudly outside production and degrades to `null` in production (letting
// the caller render a disabled stepper instead of crashing the page).
export function resolveVideoModel(id: string | null): VideoModelConfig | null {
  if (!id) return null
  if (isRegisteredVideoModel(id)) return VIDEO_MODELS[id]
  if (!isProduction()) {
    throw new UnknownVideoModelError(id)
  }
  console.error(`[models] Unrecognized video model id "${id}" - no duration bounds available`)
  return null
}

// Whether `seconds` is a value the model can actually render - a range model accepts any
// multiple of its step inside its range, a discrete model only its exact allowed values. A saved duration that fails this is flagged amber and never silently
// corrected (see DurationStepper) - only the person resolves it.
export function isDurationAllowed(config: VideoModelConfig, seconds: number): boolean {
  if (config.kind === 'discrete') return config.allowedDurations.includes(seconds)
  const steps = seconds / config.durationStep
  return seconds >= config.durationMin && seconds <= config.durationMax && Math.abs(steps - Math.round(steps)) < 1e-9
}

/** Shortest and longest shot a model can render, derived from its allowed durations. */
export function videoModelBounds(config: VideoModelConfig): { min: number; max: number } {
  return config.kind === 'continuous'
    ? { min: config.durationMin, max: config.durationMax }
    : { min: Math.min(...config.allowedDurations), max: Math.max(...config.allowedDurations) }
}

// Quality presets, ordered by cost (cheapest first). A project's settings are one of these
// or 'custom' (chosen by hand). New projects take `low` until intake offers a choice.
export type QualityPreset = {
  videoModel: VideoModelId
  videoResolution: VideoResolution
  imageQuality: ImageQuality
  imageModel: ImageModelId
}
// Every preset draws on DEFAULT_IMAGE_MODEL; another image model is an Advanced choice.
export const QUALITY_PRESETS: Record<Exclude<QualityPresetId, 'custom'>, QualityPreset> = {
  low: { videoModel: 'wan-3.0', videoResolution: '480p', imageQuality: 'low', imageModel: 'gpt-image-2.5-flare' },
  medium: { videoModel: 'seedance-2.0-mini', videoResolution: '720p', imageQuality: 'medium', imageModel: 'gpt-image-2.5-flare' },
  high: { videoModel: 'wan-3.0', videoResolution: '1080p', imageQuality: 'high', imageModel: 'gpt-image-2.5-flare' },
}
export const DEFAULT_QUALITY_PRESET = 'low' as const

// Image-model registry - the single source for which image models exist, which provider
// serves each, what each is used for and at which qualities. Never chosen by env: the
// model for a call is the project's own `image_model` (DB CHECK mirrors IMAGE_MODEL_IDS),
// checked here against the use and quality (resolveImageModel); the provider follows from
// the model. Sizes: frames use STORYBOARD_IMAGE_SIZES (storyboard.ts); element references
// are 1024x1024 - every size meets both models' size rules (multiples of 16, long:short at
// most 3:1, edges at most 3840px, 655,360-8,294,400 pixels in total). Every model here has
// an OPENAI_RATES entry (pricing.ts), and only these do.
export const IMAGE_USES = ['element_reference', 'storyboard_frame'] as const
export type ImageUse = (typeof IMAGE_USES)[number]

export type ImageModelConfig = {
  id: ImageModelId
  label: string
  /** The only image gateway is OpenAI's; a model on another provider needs its own first. */
  provider: 'openai'
  uses: readonly ImageUse[]
  /** Qualities offered (2.5's xhigh and max are excluded). */
  qualities: readonly ImageQuality[]
  /** The provider's announced shutdown date, or null when none is announced. */
  deprecatedOn: string | null
  source: readonly string[]
}

export const IMAGE_MODELS: Record<ImageModelId, ImageModelConfig> = {
  'gpt-image-2.5-flare': {
    id: 'gpt-image-2.5-flare',
    label: 'GPT Image 2.5 Flare',
    provider: 'openai',
    uses: ['element_reference', 'storyboard_frame'],
    qualities: IMAGE_QUALITIES,
    deprecatedOn: null,
    source: ['https://developers.openai.com/api/docs/models/gpt-image-2.5-flare'],
  },
  // Always reads reference images at high fidelity (input_fidelity can't be set), so a
  // reference costs more input tokens here (see OPENAI_RATES). No deprecation listed on
  // the deprecations page, checked 2026-10-09.
  'gpt-image-2': {
    id: 'gpt-image-2',
    label: 'GPT Image 2',
    provider: 'openai',
    uses: ['element_reference', 'storyboard_frame'],
    qualities: IMAGE_QUALITIES,
    deprecatedOn: null,
    source: [
      'https://developers.openai.com/api/docs/models/gpt-image-2',
      'https://developers.openai.com/api/docs/guides/image-generation',
      'https://developers.openai.com/api/docs/deprecations',
    ],
  },
}
export type { ImageModelId }
export const DEFAULT_IMAGE_MODEL: ImageModelId = 'gpt-image-2.5-flare'

export class NoImageModelError extends Error {
  constructor(model: string, use: ImageUse, quality: ImageQuality) {
    super(`Image model "${model}" does not serve ${use} at ${quality} quality.`)
    this.name = 'NoImageModelError'
  }
}

export function isRegisteredImageModel(id: string | null): id is ImageModelId {
  return id !== null && (IMAGE_MODEL_IDS as readonly string[]).includes(id)
}

/**
 * The image model - and so the provider - for one call: the project's own `image_model`,
 * if it serves this use at the quality the call sends. Anything else throws. No env lookup.
 */
export function resolveImageModel(model: string, use: ImageUse, quality: ImageQuality): ImageModelConfig {
  if (!isRegisteredImageModel(model)) throw new NoImageModelError(model, use, quality)
  const config = IMAGE_MODELS[model]
  if (!config.uses.includes(use) || !config.qualities.includes(quality)) throw new NoImageModelError(model, use, quality)
  return config
}

export class InvalidImageQualityError extends Error {
  constructor(value: string, origin: string) {
    super(`${origin} is "${value}", which is not one of ${IMAGE_QUALITIES.join(', ')}.`)
    this.name = 'InvalidImageQualityError'
  }
}

/** A project's stored `image_quality`, narrowed. The DB CHECK makes a miss a bug - it throws. */
export function parseImageQuality(value: string): ImageQuality {
  if ((IMAGE_QUALITIES as readonly string[]).includes(value)) return value as ImageQuality
  throw new InvalidImageQualityError(value, 'projects.image_quality')
}

// Thinking and effort, set explicitly per operation - never the model's default. A forced
// tool_choice skips thinking on Haiku 5.5 (the response starts with the tool call), so
// every forced route says 'disabled', and its max_tokens covers output alone; the agent
// (tool_choice auto) is the one route that thinks. 'disabled' is accepted at effort
// low/medium/high only - xhigh/max with it is a 400.
export type ClaudeEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'
export type ClaudeReasoning = { thinking: 'adaptive' | 'disabled'; effort: ClaudeEffort }

// Models the reasoning settings are sent to. A model absent here gets neither field, so a
// Sonnet 5 production request (or an env override back to an older Haiku, which rejects
// effort) is unchanged. Add a model when its reasoning is tuned.
export const CLAUDE_REASONING_MODELS: ReadonlySet<string> = new Set(['claude-haiku-5-5'])

export function claudeReasoningParams(section: {
  model: string
  reasoning: ClaudeReasoning
}): { thinking?: { type: 'adaptive' | 'disabled' }; output_config?: { effort: ClaudeEffort } } {
  if (!CLAUDE_REASONING_MODELS.has(section.model)) return {}
  return { thinking: { type: section.reasoning.thinking }, output_config: { effort: section.reasoning.effort } }
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
