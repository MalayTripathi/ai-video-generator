'use client'

import { useState } from 'react'
import { displayTitle } from '@/lib/display-title'
import { durationConfig, type DurationTarget } from '@/lib/config/duration'
import { createProjectFromIntake } from '../actions'
import type { TemplateProject } from '../types'
import { BuildButton } from './build-button'

type AspectRatio = '9:16' | '16:9' | '1:1'
type PrefillableField = 'video_type' | 'aspect_ratio' | 'duration_target'

const DEFAULTS = {
  videoType: 'auto',
  aspectRatio: '9:16' as AspectRatio,
  durationTarget: '1-2min' as DurationTarget,
}

const VIDEO_TYPES: { value: string; label: string }[] = [
  { value: 'auto', label: 'Detect from my text' },
  { value: 'narrated_story', label: 'Narrated Story' },
  { value: 'explainer', label: 'Explainer' },
  { value: 'facts_listicle', label: 'Facts & Listicle' },
  { value: 'character_drama', label: 'Character Drama' },
  { value: 'product_ad', label: 'Product Ad' },
  { value: 'trailer', label: 'Trailer' },
]

const FORMATS: { value: AspectRatio; label: string; sublabel: string; width: number; height: number }[] = [
  { value: '9:16', label: '9:16', sublabel: 'Reels, Shorts', width: 16, height: 24 },
  { value: '16:9', label: '16:9', sublabel: 'YouTube', width: 24, height: 16 },
  { value: '1:1', label: '1:1', sublabel: 'Feed post', width: 20, height: 20 },
]

const DURATIONS = Object.entries(durationConfig) as [DurationTarget, (typeof durationConfig)[DurationTarget]][]

function tileClass(selected: boolean) {
  return selected
    ? 'flex cursor-pointer flex-col items-center justify-center gap-rc-2xs rounded-control border border-accent bg-accent-wash text-accent outline-none has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-accent has-[:focus-visible]:outline-offset-2'
    : 'flex cursor-pointer flex-col items-center justify-center gap-rc-2xs rounded-control border border-border-strong bg-bg-surface text-text-secondary outline-none hover:border-border-strong-hover hover:bg-bg-surface-hover has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-accent has-[:focus-visible]:outline-offset-2'
}

export function IntakeForm({ recentProjects }: { recentProjects: TemplateProject[] }) {
  const [template, setTemplate] = useState<TemplateProject | null>(null)
  const [sourceText, setSourceText] = useState('')
  const [videoType, setVideoType] = useState(DEFAULTS.videoType)
  const [aspectRatio, setAspectRatio] = useState<AspectRatio>(DEFAULTS.aspectRatio)
  const [durationTarget, setDurationTarget] = useState<DurationTarget>(DEFAULTS.durationTarget)
  const [prefilled, setPrefilled] = useState<Set<PrefillableField>>(new Set())

  function dropPrefilled(field: PrefillableField) {
    setPrefilled((prev) => {
      if (!prev.has(field)) return prev
      const next = new Set(prev)
      next.delete(field)
      return next
    })
  }

  function selectTemplate(project: TemplateProject | null) {
    if (!project) {
      setTemplate(null)
      setVideoType(DEFAULTS.videoType)
      setAspectRatio(DEFAULTS.aspectRatio)
      setDurationTarget(DEFAULTS.durationTarget)
      setPrefilled(new Set())
      return
    }

    setTemplate(project)
    setVideoType(project.video_type ?? DEFAULTS.videoType)
    setAspectRatio((project.aspect_ratio as AspectRatio | null) ?? DEFAULTS.aspectRatio)
    setDurationTarget((project.duration_target as DurationTarget | null) ?? DEFAULTS.durationTarget)
    setPrefilled(new Set(['video_type', 'aspect_ratio', 'duration_target']))
  }

  return (
    <form action={createProjectFromIntake} className="flex flex-col gap-rc-lg">
      <input type="hidden" name="template_source_id" value={template?.id ?? ''} />
      <input type="hidden" name="language" value={template?.language ?? ''} />
      <input type="hidden" name="video_model" value={template?.video_model ?? ''} />

      <div className="flex flex-col gap-rc-xs">
        <span className="text-label uppercase tracking-label text-text-tertiary">
          Start from an earlier project
        </span>
        <div role="radiogroup" aria-label="Start from an earlier project" className="flex flex-wrap gap-rc-xs">
          <Chip label="Start Fresh" selected={!template} onSelect={() => selectTemplate(null)} />
          {recentProjects.map((project) => (
            <Chip
              key={project.id}
              label={displayTitle(project)}
              selected={template?.id === project.id}
              onSelect={() => selectTemplate(project)}
            />
          ))}
        </div>
        {template && (
          <div className="flex items-center gap-rc-xs pt-rc-3xs">
            <span className="text-meta text-text-secondary">
              Copying settings from <span className="text-text-primary">{displayTitle(template)}</span>
            </span>
            <button
              type="button"
              onClick={() => selectTemplate(null)}
              className="cursor-pointer text-meta font-medium text-accent outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
            >
              Clear
            </button>
          </div>
        )}
      </div>

      <textarea
        name="source_text"
        required
        value={sourceText}
        onChange={(event) => setSourceText(event.target.value)}
        placeholder="Describe your idea, paste a script, or paste a screenplay — anything works."
        rows={6}
        className="min-h-[130px] resize-y rounded-badge border border-border-strong bg-bg-surface px-[11px] py-[10px] text-control leading-[1.5] text-text-primary outline-none placeholder:text-text-tertiary focus-visible:border-accent focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent"
      />

      <div className="flex flex-col gap-rc-xs">
        <div className="flex items-center gap-rc-xs">
          <span className="text-label uppercase tracking-label text-text-tertiary">What kind of video?</span>
          {prefilled.has('video_type') && <PrefilledBadge />}
        </div>
        <select
          name="video_type"
          value={videoType}
          onChange={(event) => {
            setVideoType(event.target.value)
            dropPrefilled('video_type')
          }}
          className="h-[38px] cursor-pointer rounded-badge border border-border-strong bg-bg-surface px-[11px] text-control text-text-primary outline-none focus-visible:border-accent focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent"
        >
          {VIDEO_TYPES.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
        {videoType === 'auto' && (
          <span className="text-small text-text-secondary">
            Recommended. The agent reads what you wrote and picks.
          </span>
        )}
      </div>

      <div className="flex flex-col gap-rc-xs">
        <div className="flex items-center gap-rc-xs">
          <span className="text-label uppercase tracking-label text-text-tertiary">Format</span>
          {prefilled.has('aspect_ratio') && <PrefilledBadge />}
        </div>
        <div role="radiogroup" aria-label="Format" className="grid grid-cols-3 gap-rc-sm">
          {FORMATS.map((format) => {
            const selected = aspectRatio === format.value
            return (
              <label key={format.value} className={`${tileClass(selected)} h-[96px]`}>
                <input
                  type="radio"
                  name="aspect_ratio"
                  value={format.value}
                  checked={selected}
                  onChange={() => {
                    setAspectRatio(format.value)
                    dropPrefilled('aspect_ratio')
                  }}
                  className="sr-only"
                />
                <svg width="16" height="24" viewBox={`0 0 ${format.width} ${format.height}`} fill="none" aria-hidden="true">
                  <rect
                    x="0.75"
                    y="0.75"
                    width={format.width - 1.5}
                    height={format.height - 1.5}
                    rx="2"
                    stroke="currentColor"
                    strokeWidth="1.5"
                  />
                </svg>
                <span className="text-control font-medium">{format.label}</span>
                <span className={selected ? 'text-chip text-accent-quiet' : 'text-chip text-text-tertiary'}>
                  {format.sublabel}
                </span>
              </label>
            )
          })}
        </div>
      </div>

      <div className="flex flex-col gap-rc-xs">
        <div className="flex items-center gap-rc-xs">
          <span className="text-label uppercase tracking-label text-text-tertiary">
            How long should this be?
          </span>
          {prefilled.has('duration_target') && <PrefilledBadge />}
        </div>
        <div role="radiogroup" aria-label="Duration" className="grid grid-cols-2 gap-rc-sm">
          {DURATIONS.map(([value, config]) => {
            const selected = durationTarget === value
            return (
              <label key={value} className={`${tileClass(selected)} h-[56px]`}>
                <input
                  type="radio"
                  name="duration_target"
                  value={value}
                  checked={selected}
                  onChange={() => {
                    setDurationTarget(value)
                    dropPrefilled('duration_target')
                  }}
                  className="sr-only"
                />
                <span className="text-body font-medium">{config.label}</span>
                <span className={selected ? 'text-chip text-accent-quiet' : 'text-chip text-text-tertiary'}>
                  ~{config.targetShots} shots
                </span>
              </label>
            )
          })}
        </div>
      </div>

      <div className="flex flex-col gap-rc-2xs">
        <span className="text-meta text-text-secondary">
          ≈ <span className="font-mono">{durationConfig[durationTarget].estimatedCredits}</span> credits
        </span>
        <BuildButton disabled={sourceText.trim().length === 0} />
      </div>
    </form>
  )
}

function PrefilledBadge() {
  return (
    <span className="rounded-badge bg-accent-wash px-rc-2xs py-px text-chip text-accent-quiet">prefilled</span>
  )
}

function Chip({ label, selected, onSelect }: { label: string; selected: boolean; onSelect: () => void }) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      onClick={onSelect}
      className={
        selected
          ? 'flex h-7 max-w-[200px] cursor-pointer items-center gap-rc-2xs rounded-full border border-accent bg-accent-wash px-rc-sm text-small font-medium text-accent outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent'
          : 'flex h-7 max-w-[200px] cursor-pointer items-center gap-rc-2xs rounded-full border border-border-strong bg-bg-surface px-rc-sm text-small text-text-secondary outline-none hover:border-border-strong-hover hover:bg-bg-surface-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent'
      }
    >
      {selected && (
        <svg width="10" height="8" viewBox="0 0 10 8" fill="none" aria-hidden="true">
          <path d="M1 4.25 3.5 6.75 9 1.25" stroke="currentColor" strokeWidth="1.5" />
        </svg>
      )}
      <span className="truncate">{label}</span>
    </button>
  )
}
