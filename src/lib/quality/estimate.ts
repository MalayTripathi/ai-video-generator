import { durationConfig, type DurationTarget } from '@/lib/config/duration'
import {
  IMAGE_MODEL_IDS,
  IMAGE_QUALITIES,
  QUALITY_PRESET_IDS,
  VIDEO_RESOLUTIONS,
  type AspectRatio,
  type ImageModelId,
  type ImageQuality,
  type QualityPresetId,
  type VideoResolution,
} from '@/lib/config/enums'
import {
  QUALITY_PRESETS,
  VIDEO_MODELS,
  VIDEO_MODEL_IDS,
  isRegisteredVideoModel,
  resolveImageModel,
  videoModelBounds,
  type VideoModelId,
  type VideoModelTier,
} from '@/lib/config/models'
import { CREDIT_MARGIN, imageCredits, usdToCredits } from '@/lib/config/credits'
import { videoUsdPerSecond } from '@/lib/config/pricing'
import { STORYBOARD_IMAGE_SIZES } from '@/lib/config/storyboard'

// The one source for every rate, badge and estimate the Quality picker shows - at intake
// and in the project settings drawer. Pure and client-importable: everything is read from
// the model registry and the duration tiers, with no server call. Estimates price the
// project's own image model and quality (never the dev cap) with no references, and video with
// audio off - an upper bound on frames and clips, shown as "≈".

export type QualitySettings = {
  preset: QualityPresetId
  videoModel: VideoModelId
  videoResolution: VideoResolution
  imageQuality: ImageQuality
  imageModel: ImageModelId
}

/**
 * Whether the model renders at `res`. A model whose output resolution isn't selectable
 * (`resolutions: null`) takes no resolution parameter and renders at one price whatever
 * the project's resolution is, so it supports every one.
 */
export function supportsResolution(model: VideoModelId, res: VideoResolution): boolean {
  const resolutions = VIDEO_MODELS[model].resolutions
  return resolutions === null || resolutions.includes(res)
}

/** Whether the person can pick a resolution for this model at all. */
export function hasSelectableResolution(model: VideoModelId): boolean {
  return VIDEO_MODELS[model].resolutions !== null
}

/** The highest resolution the model offers - where a resolution it doesn't support drops to. */
export function highestResolution(model: VideoModelId): VideoResolution {
  const resolutions = VIDEO_MODELS[model].resolutions ?? VIDEO_RESOLUTIONS
  return [...resolutions].sort((a, b) => VIDEO_RESOLUTIONS.indexOf(b) - VIDEO_RESOLUTIONS.indexOf(a))[0]
}

function usdPerSecond(model: VideoModelId, res: VideoResolution): number | null {
  return supportsResolution(model, res) ? videoUsdPerSecond({ model, resolution: res, audio: false }) : null
}

/** Credits per second of clip at this resolution, audio off; null when unsupported. */
export function videoCreditsPerSecond(model: VideoModelId, res: VideoResolution): number | null {
  const usd = usdPerSecond(model, res)
  return usd === null ? null : usdToCredits(usd * CREDIT_MARGIN)
}

/** Credits for one storyboard frame on this model, at this quality and aspect ratio. */
export function frameCredits(
  model: ImageModelId,
  quality: ImageQuality,
  aspectRatio: AspectRatio,
  referenceCount = 0
): number {
  return imageCredits({
    model: resolveImageModel(model, 'storyboard_frame', quality).id,
    quality,
    size: STORYBOARD_IMAGE_SIZES[aspectRatio],
    referenceCount,
  })
}

const TIERS: readonly VideoModelTier[] = ['Budget', 'Standard', 'Premium']

/**
 * Tier badges at one resolution: the models that support it, ranked by rate - the
 * cheapest third Budget, the middle third Standard, the top third Premium. A model that
 * doesn't support the resolution gets no badge.
 */
export function tierBadges(res: VideoResolution): Partial<Record<VideoModelId, VideoModelTier>> {
  const ranked = VIDEO_MODEL_IDS.flatMap((id) => {
    const usd = usdPerSecond(id, res)
    return usd === null ? [] : [{ id, usd }]
  }).sort((a, b) => a.usd - b.usd)
  return Object.fromEntries(
    ranked.map(({ id }, i) => [id, TIERS[Math.floor((i * TIERS.length) / ranked.length)]])
  )
}

/**
 * The upper-bound credit estimate for a project: the tier's target shots x one frame at
 * the chosen image quality, plus the tier's maximum seconds x the clip rate at the chosen
 * model and resolution (audio off). The clip part rounds up once, as a clip's price does.
 */
export function estimateCredits(params: {
  durationTarget: DurationTarget
  aspectRatio: AspectRatio
  videoModel: VideoModelId
  videoResolution: VideoResolution
  imageQuality: ImageQuality
  imageModel: ImageModelId
}): number {
  const tier = durationConfig[params.durationTarget]
  const usd = usdPerSecond(params.videoModel, params.videoResolution)
  if (usd === null) throw new Error(`${params.videoModel} does not render at ${params.videoResolution}.`)
  return (
    tier.targetShots * frameCredits(params.imageModel, params.imageQuality, params.aspectRatio) +
    usdToCredits(usd * tier.targetSecondsMax * CREDIT_MARGIN)
  )
}

/** A preset's own settings, as the picker stores them. */
export function presetSettings(id: Exclude<QualityPresetId, 'custom'>): QualitySettings {
  const preset = QUALITY_PRESETS[id]
  return {
    preset: id,
    videoModel: preset.videoModel,
    videoResolution: preset.videoResolution,
    imageQuality: preset.imageQuality,
    imageModel: preset.imageModel,
  }
}

/** The longest shot a model renders, in seconds. */
export function maxShotSeconds(model: VideoModelId): number {
  return videoModelBounds(VIDEO_MODELS[model]).max
}

export class UnsupportedQualityError extends Error {
  constructor(detail: string) {
    super(`Unsupported quality settings: ${detail}.`)
    this.name = 'UnsupportedQualityError'
  }
}

/**
 * Narrows raw input to settings the registry supports, or throws UnsupportedQualityError.
 * A named preset must match its registry entry exactly - otherwise it is 'custom'.
 */
export function parseQualitySettings(raw: {
  preset: unknown
  videoModel: unknown
  videoResolution: unknown
  imageQuality: unknown
  imageModel: unknown
}): QualitySettings {
  const { preset, videoModel, videoResolution, imageQuality, imageModel } = raw
  if (typeof preset !== 'string' || !(QUALITY_PRESET_IDS as readonly string[]).includes(preset)) {
    throw new UnsupportedQualityError('unknown preset')
  }
  if (typeof videoModel !== 'string' || !isRegisteredVideoModel(videoModel)) {
    throw new UnsupportedQualityError('unknown video model')
  }
  if (typeof videoResolution !== 'string' || !(VIDEO_RESOLUTIONS as readonly string[]).includes(videoResolution)) {
    throw new UnsupportedQualityError('unknown resolution')
  }
  if (typeof imageQuality !== 'string' || !(IMAGE_QUALITIES as readonly string[]).includes(imageQuality)) {
    throw new UnsupportedQualityError('unknown image quality')
  }
  if (typeof imageModel !== 'string' || !(IMAGE_MODEL_IDS as readonly string[]).includes(imageModel)) {
    throw new UnsupportedQualityError('unknown image model')
  }
  const settings = {
    preset: preset as QualityPresetId,
    videoModel,
    videoResolution: videoResolution as VideoResolution,
    imageQuality: imageQuality as ImageQuality,
    imageModel: imageModel as ImageModelId,
  }
  // Every model must serve both uses at the chosen quality - one setting drives both.
  try {
    resolveImageModel(settings.imageModel, 'storyboard_frame', settings.imageQuality)
    resolveImageModel(settings.imageModel, 'element_reference', settings.imageQuality)
  } catch {
    throw new UnsupportedQualityError('the image model does not offer that quality')
  }
  if (!supportsResolution(settings.videoModel, settings.videoResolution)) {
    throw new UnsupportedQualityError('the model does not render at that resolution')
  }
  if (settings.preset !== 'custom') {
    const expected = presetSettings(settings.preset)
    if (
      expected.videoModel !== settings.videoModel ||
      expected.videoResolution !== settings.videoResolution ||
      expected.imageQuality !== settings.imageQuality ||
      expected.imageModel !== settings.imageModel
    ) {
      throw new UnsupportedQualityError('the values do not match the preset')
    }
  }
  return settings
}
