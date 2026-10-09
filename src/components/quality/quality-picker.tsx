'use client'

import { useState } from 'react'
import type { DurationTarget } from '@/lib/config/duration'
import {
  IMAGE_MODEL_IDS,
  IMAGE_QUALITIES,
  VIDEO_RESOLUTIONS,
  type AspectRatio,
  type ImageModelId,
  type ImageQuality,
  type VideoResolution,
} from '@/lib/config/enums'
import { IMAGE_MODELS, QUALITY_PRESETS, VIDEO_MODELS, VIDEO_MODEL_IDS, type VideoModelId } from '@/lib/config/models'
import {
  estimateCredits,
  frameCredits,
  hasSelectableResolution,
  highestResolution,
  maxShotSeconds,
  presetSettings,
  supportsResolution,
  tierBadges,
  videoCreditsPerSecond,
  type QualitySettings,
} from '@/lib/quality/estimate'

// The Quality group (canvas sections 17 and 18): three preset rows, then Advanced - video
// model cards, resolution and image quality. Controlled: the caller owns the value, so
// intake submits it and the settings drawer stages it. Opening Advanced or changing
// anything inside it makes the value 'custom'. With `locked`, the presets, model and
// resolution are disabled and the image model and quality stay editable.

const PRESET_IDS = Object.keys(QUALITY_PRESETS) as (keyof typeof QUALITY_PRESETS)[]
const PRESET_NAMES: Record<keyof typeof QUALITY_PRESETS, string> = { low: 'Low', medium: 'Medium', high: 'High' }
const IMAGE_QUALITY_LABELS: Record<ImageQuality, string> = { low: 'Low', medium: 'Medium', high: 'High' }

const formatCredits = (n: number) => (Math.round(n / 10) * 10).toLocaleString('en-US')

// The spec line under a model's name, from its registry entry, split at the dots so each
// part wraps whole.
function modelSpec(id: VideoModelId): string[] {
  const config = VIDEO_MODELS[id]
  const duration =
    config.kind === 'discrete'
      ? `${config.allowedDurations.slice(0, -1).join('s, ')}s or ${config.allowedDurations.at(-1)}s per shot`
      : `${config.durationMin}–${config.durationMax}s per shot`
  const resolutions =
    config.resolutions === null
      ? 'fixed resolution'
      : config.resolutions.length === 1
        ? config.resolutions[0]
        : `${config.resolutions[0]}–${config.resolutions.at(-1)}`
  const audio =
    config.audio.mode === 'generated' ? 'audio' : config.audio.mode === 'input_only' ? 'no generated audio' : 'no audio'
  const extras = config.references.supported ? `${audio}, references` : audio
  return [duration, resolutions, extras]
}

function resolutionTooltip(model: VideoModelId, res: VideoResolution): string {
  const config = VIDEO_MODELS[model]
  if (config.resolutions === null) return `${config.label} sets its own output resolution`
  if (config.resolutions.length === 1) return `${config.label} supports ${config.resolutions[0]} only`
  const top = highestResolution(model)
  return VIDEO_RESOLUTIONS.indexOf(res) > VIDEO_RESOLUTIONS.indexOf(top)
    ? `${config.label} supports up to ${top}`
    : `${config.label} supports ${config.resolutions[0]} and up`
}

function rowClass(selected: boolean, disabled: boolean) {
  const base =
    'flex min-w-0 items-center justify-between gap-rc-sm rounded-control border px-[12px] py-[10px] text-left outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent'
  const tone = selected ? 'border-accent bg-accent-wash' : 'border-border-strong bg-bg-surface'
  const cursor = disabled ? 'cursor-not-allowed opacity-45' : 'cursor-pointer'
  return `${base} ${tone} ${cursor}`
}

function segmentClass(selected: boolean) {
  return selected
    ? 'bg-accent-wash text-accent shadow-[inset_0_0_0_1px_var(--accent)]'
    : 'bg-transparent text-text-secondary'
}

export function QualityPicker({
  value,
  onChange,
  durationTarget,
  aspectRatio,
  locked = false,
  badge = null,
}: {
  value: QualitySettings
  onChange: (next: QualitySettings) => void
  durationTarget: DurationTarget
  aspectRatio: AspectRatio
  locked?: boolean
  /** Shown beside the Quality label (intake's "Pre-filled"). */
  badge?: React.ReactNode
}) {
  const custom = value.preset === 'custom'
  const [advancedOpen, setAdvancedOpen] = useState(custom)
  // The auto-drop notice; it clears on the next resolution or model change.
  const [notice, setNotice] = useState<string | null>(null)

  function goCustom(patch: Partial<QualitySettings>) {
    onChange({ ...value, ...patch, preset: 'custom' })
  }

  function pickPreset(id: keyof typeof QUALITY_PRESETS) {
    if (locked) return
    onChange(presetSettings(id))
    setAdvancedOpen(false)
    setNotice(null)
  }

  function toggleAdvanced() {
    if (advancedOpen) {
      setAdvancedOpen(false)
      return
    }
    setAdvancedOpen(true)
    if (!locked && !custom) goCustom({})
  }

  function pickModel(id: VideoModelId) {
    if (locked || id === value.videoModel) return
    if (supportsResolution(id, value.videoResolution)) {
      setNotice(null)
      goCustom({ videoModel: id })
      return
    }
    const res = highestResolution(id)
    setNotice(`Resolution set to ${res}. ${VIDEO_MODELS[id].label} supports up to ${res}.`)
    goCustom({ videoModel: id, videoResolution: res })
  }

  function pickResolution(res: VideoResolution) {
    if (locked || res === value.videoResolution || !hasSelectableResolution(value.videoModel)) return
    if (!supportsResolution(value.videoModel, res)) return
    setNotice(null)
    goCustom({ videoResolution: res })
  }

  function pickImageQuality(quality: ImageQuality) {
    if (quality === value.imageQuality) return
    goCustom({ imageQuality: quality })
  }

  // Like image quality, the image model stays editable after the lock.
  function pickImageModel(model: ImageModelId) {
    if (model === value.imageModel) return
    goCustom({ imageModel: model })
  }

  const tiers = tierBadges(value.videoResolution)
  const resolutionSelectable = hasSelectableResolution(value.videoModel)

  return (
    <div className="flex flex-col gap-rc-lg" data-testid="quality-picker">
      <div className="flex flex-col gap-rc-xs">
        <div className="flex h-4 items-center gap-rc-xs">
          <span className="text-label uppercase tracking-label text-text-tertiary">Quality</span>
          {custom && (
            <span
              data-testid="quality-custom-label"
              className="rounded-badge border border-border-subtle bg-bg-inset px-[6px] text-chip font-medium leading-4 text-text-secondary"
            >
              Custom
            </span>
          )}
          {badge}
        </div>
        <div role="radiogroup" aria-label="Quality" aria-disabled={locked} className="flex flex-col gap-rc-xs">
          {PRESET_IDS.map((id) => {
            const preset = presetSettings(id)
            const selected = !custom && value.preset === id
            const credits = estimateCredits({ durationTarget, aspectRatio, ...preset })
            return (
              <button
                key={id}
                type="button"
                role="radio"
                aria-checked={selected}
                disabled={locked}
                onClick={() => pickPreset(id)}
                data-testid={`quality-preset-${id}`}
                className={rowClass(selected, locked)}
              >
                <span className="flex min-w-0 flex-col gap-[2px]">
                  <span className={`mb-[2px] whitespace-nowrap text-control font-medium ${selected ? 'text-accent' : 'text-text-primary'}`}>
                    {PRESET_NAMES[id]}
                  </span>
                  <span className={`whitespace-nowrap text-chip leading-[1.4] ${selected ? 'text-accent-quiet' : 'text-text-tertiary'}`}>
                    {hasSelectableResolution(preset.videoModel) ? `${preset.videoResolution} · ` : ''}
                    up to {maxShotSeconds(preset.videoModel)}s per shot
                  </span>
                  <span className={`whitespace-nowrap text-chip leading-[1.4] ${selected ? 'text-accent-quiet' : 'text-text-tertiary'}`}>
                    {VIDEO_MODELS[preset.videoModel].label}
                  </span>
                </span>
                <span
                  data-testid={`quality-preset-${id}-estimate`}
                  className={`flex-none whitespace-nowrap text-meta tabular-nums ${selected ? 'text-accent-quiet' : 'text-text-secondary'}`}
                >
                  ≈ {formatCredits(credits)} credits
                </span>
              </button>
            )
          })}
        </div>
        <span className="text-meta leading-[1.5] text-text-tertiary">
          Estimate covers storyboard frames and video clips. Voiceover and music are extra and optional.
        </span>
      </div>

      <div className="flex flex-col gap-[18px]">
        <button
          type="button"
          onClick={toggleAdvanced}
          aria-expanded={advancedOpen}
          className="-ml-[2px] flex h-7 cursor-pointer items-center gap-[6px] self-start rounded-badge pr-rc-xs pl-[2px] text-small font-medium text-text-secondary outline-none hover:bg-bg-inset hover:text-text-primary focus-visible:outline-2 focus-visible:outline-accent"
        >
          <svg
            width="10"
            height="10"
            viewBox="0 0 10 10"
            fill="none"
            aria-hidden="true"
            className="transition-transform duration-[120ms]"
            style={{ transform: `rotate(${advancedOpen ? 90 : 0}deg)` }}
          >
            <path d="M3.5 1.5 7 5 3.5 8.5" stroke="currentColor" strokeWidth="1.4" />
          </svg>
          Advanced
        </button>

        {advancedOpen && (
          <div className="flex flex-col gap-[22px] border-l border-border-hairline pl-rc-md">
            <div className="flex flex-col gap-rc-xs">
              <span className="text-label uppercase tracking-label text-text-tertiary">Video model</span>
              <div role="radiogroup" aria-label="Video model" aria-disabled={locked} className="grid auto-rows-fr grid-cols-2 gap-rc-xs">
                {VIDEO_MODEL_IDS.map((id) => {
                  const selected = id === value.videoModel
                  const supported = supportsResolution(id, value.videoResolution)
                  const rate = videoCreditsPerSecond(id, value.videoResolution)
                  const rateText =
                    rate === null
                      ? `— at ${value.videoResolution}`
                      : hasSelectableResolution(id)
                        ? `${rate} cr/s at ${value.videoResolution}`
                        : `${rate} cr/s at any resolution`
                  const segments = modelSpec(id)
                  return (
                    <button
                      key={id}
                      type="button"
                      role="radio"
                      aria-checked={selected}
                      disabled={locked}
                      onClick={() => pickModel(id)}
                      data-testid={`quality-model-${id}`}
                      data-supported={supported}
                      className={`flex flex-col gap-[5px] rounded-control border px-[10px] pt-[9px] pb-[10px] text-left outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent ${
                        selected ? 'border-accent bg-accent-wash' : 'border-border-strong bg-bg-surface'
                      } ${locked ? 'cursor-not-allowed opacity-45' : 'cursor-pointer'} ${!supported && !selected ? 'opacity-50' : ''}`}
                    >
                      <span className={`whitespace-nowrap text-small font-medium ${selected ? 'text-accent' : 'text-text-primary'}`}>
                        {VIDEO_MODELS[id].label}
                      </span>
                      <span className="flex h-4 items-center">
                        {supported && tiers[id] && (
                          <span
                            data-testid={`quality-model-${id}-tier`}
                            className="rounded-badge bg-bg-inset px-[5px] text-chip leading-4 text-text-secondary"
                          >
                            {tiers[id]}
                          </span>
                        )}
                      </span>
                      <span className={`flex flex-wrap gap-x-1 text-chip leading-[1.4] ${selected ? 'text-accent-quiet' : 'text-text-tertiary'}`}>
                        {segments.map((segment, i) => (
                          <span key={segment} className="whitespace-nowrap">
                            {i < segments.length - 1 ? `${segment} ·` : segment}
                          </span>
                        ))}
                      </span>
                      <span
                        data-testid={`quality-model-${id}-rate`}
                        className={`mt-auto pt-[2px] text-meta tabular-nums ${selected ? 'text-accent' : 'text-text-secondary'}`}
                      >
                        {rateText}
                      </span>
                    </button>
                  )
                })}
              </div>
            </div>

            <div className="flex flex-col gap-rc-xs">
              <span className="text-label uppercase tracking-label text-text-tertiary">Resolution</span>
              <div
                role="radiogroup"
                aria-label="Resolution"
                aria-disabled={locked}
                className={`grid grid-cols-3 gap-[2px] rounded-control border border-border-strong bg-bg-surface p-[2px] ${locked ? 'opacity-45' : ''}`}
              >
                {VIDEO_RESOLUTIONS.map((res) => {
                  const off = !resolutionSelectable || !supportsResolution(value.videoModel, res)
                  const selected = res === value.videoResolution
                  const tip = off ? resolutionTooltip(value.videoModel, res) : undefined
                  return (
                    <button
                      key={res}
                      type="button"
                      role="radio"
                      aria-checked={selected}
                      aria-disabled={off || locked}
                      disabled={locked}
                      title={tip}
                      onClick={() => pickResolution(res)}
                      data-testid={`quality-resolution-${res}`}
                      className={`group relative flex h-[30px] items-center justify-center rounded-badge text-small font-medium outline-none focus-visible:outline-2 focus-visible:outline-accent ${segmentClass(selected)} ${
                        off && !selected ? 'text-text-quiet' : ''
                      } ${off || locked ? 'cursor-not-allowed' : 'cursor-pointer'}`}
                    >
                      <span className={off ? 'opacity-45' : ''}>{res}</span>
                      {tip && !locked && (
                        <span
                          role="tooltip"
                          className="pointer-events-none absolute right-[-2px] bottom-[calc(100%+8px)] z-10 hidden whitespace-nowrap rounded-badge bg-rail-bg px-[9px] py-[6px] text-chip font-normal text-rail-fg shadow-card-hover group-hover:block"
                        >
                          {tip}
                        </span>
                      )}
                    </button>
                  )
                })}
              </div>
              {notice && (
                <div
                  role="status"
                  data-testid="quality-resolution-notice"
                  className="flex items-center gap-[7px] self-start rounded-badge bg-status-active-bg px-rc-xs py-1 text-meta leading-[1.4] text-status-active-fg"
                >
                  <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true" className="flex-none">
                    <circle cx="6" cy="6" r="5.25" stroke="currentColor" strokeWidth="1.2" />
                    <rect x="5.4" y="5" width="1.2" height="3.6" fill="currentColor" />
                    <rect x="5.4" y="3" width="1.2" height="1.2" fill="currentColor" />
                  </svg>
                  {notice}
                </div>
              )}
            </div>

            <div className="flex flex-col gap-rc-xs">
              <span className="text-label uppercase tracking-label text-text-tertiary">Image quality</span>
              <div role="radiogroup" aria-label="Image quality" className="grid grid-cols-3 gap-[2px] rounded-control border border-border-strong bg-bg-surface p-[2px]">
                {IMAGE_QUALITIES.map((quality) => {
                  const selected = quality === value.imageQuality
                  return (
                    <button
                      key={quality}
                      type="button"
                      role="radio"
                      aria-checked={selected}
                      onClick={() => pickImageQuality(quality)}
                      data-testid={`quality-image-${quality}`}
                      className={`flex h-[42px] cursor-pointer flex-col items-center justify-center gap-px rounded-badge outline-none focus-visible:outline-2 focus-visible:outline-accent ${segmentClass(selected)}`}
                    >
                      <span className="text-small font-medium">{IMAGE_QUALITY_LABELS[quality]}</span>
                      <span className={`text-chip tabular-nums ${selected ? 'text-accent-quiet' : 'text-text-tertiary'}`}>
                        {frameCredits(value.imageModel, quality, aspectRatio)} cr/frame
                      </span>
                    </button>
                  )
                })}
              </div>
            </div>

            <div className="flex flex-col gap-rc-xs">
              <span className="text-label uppercase tracking-label text-text-tertiary">Image model</span>
              <div
                role="radiogroup"
                aria-label="Image model"
                className="grid grid-cols-2 gap-[2px] rounded-control border border-border-strong bg-bg-surface p-[2px]"
              >
                {IMAGE_MODEL_IDS.map((model) => {
                  const selected = model === value.imageModel
                  return (
                    <button
                      key={model}
                      type="button"
                      role="radio"
                      aria-checked={selected}
                      onClick={() => pickImageModel(model)}
                      data-testid={`quality-image-model-${model}`}
                      className={`flex h-[42px] cursor-pointer flex-col items-center justify-center gap-px rounded-badge outline-none focus-visible:outline-2 focus-visible:outline-accent ${segmentClass(selected)}`}
                    >
                      <span className="text-small font-medium">{IMAGE_MODELS[model].label}</span>
                      <span className={`text-chip tabular-nums ${selected ? 'text-accent-quiet' : 'text-text-tertiary'}`}>
                        {frameCredits(model, value.imageQuality, aspectRatio)} cr/frame
                      </span>
                    </button>
                  )
                })}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
