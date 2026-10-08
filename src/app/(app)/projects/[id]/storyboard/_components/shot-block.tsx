'use client'

import { memo, type CSSProperties, type KeyboardEvent, type MouseEvent } from 'react'
import { formatCredits } from '@/lib/format-credits'
import type { AspectRatio } from '@/lib/config/enums'
import { etaFor, filmDuration, THUMB_EDGE_NARROW_PX, THUMB_EDGE_WIDE_PX, thumbBox, type BlockTier } from '@/lib/storyboard/timeline'
import type { ShotImageStatus, StoryboardShot } from './types'

// Visual state of one block (canvas 15c a). "generating" covers queued too - both are the
// in-flight token, never amber.
export type BlockLook = 'ready' | 'stale' | 'failed' | 'generating' | 'not_generated'

export function lookFor(state: ShotImageStatus['state']): BlockLook {
  if (state === 'queued' || state === 'generating') return 'generating'
  return state
}

export function shotName(shot: Pick<StoryboardShot, 'visual_description' | 'order_index'>): string {
  const text = shot.visual_description?.trim()
  return text ? text : `Shot ${shot.order_index + 1}`
}

// What a picture-lane block reads: the shot's narration, falling back to its visual
// description only when the narration is empty. Truncated on the block, whole in its tooltip.
export function blockText(shot: Pick<StoryboardShot, 'voice_over' | 'visual_description' | 'order_index'>): string {
  const narration = shot.voice_over?.trim()
  return narration ? narration : shotName(shot)
}

export function formatSeconds(durationSec: number | null): string {
  return durationSec !== null ? `${durationSec.toFixed(1)}s` : '—'
}

export const CONTAINER: Record<BlockLook, string> = {
  ready: 'bg-bg-surface border-border-subtle border-solid',
  stale: 'bg-bg-surface border-status-stale-line border-solid',
  failed: 'bg-status-failed-bg border-status-failed-line border-solid',
  generating: 'bg-bg-inset border-sb-active-line border-solid',
  not_generated: 'bg-bg-well border-border-muted border-dashed',
}

export const NUMBER_INK: Record<BlockLook, string> = {
  ready: 'text-text-tertiary',
  stale: 'text-text-tertiary',
  failed: 'text-status-failed-fg',
  generating: 'text-text-quiet',
  not_generated: 'text-text-quiet',
}

export const NAME_INK: Record<BlockLook, string> = {
  ready: 'text-text-secondary',
  stale: 'text-text-secondary',
  failed: 'text-banner-failed-body',
  generating: 'text-text-secondary',
  not_generated: 'text-text-quiet',
}

function ProgressRule({ pct, className }: { pct: number; className: string }) {
  return (
    <span className={`block h-[3px] overflow-hidden rounded-[2px] bg-sb-active-line ${className}`}>
      <span className="block h-[3px] rounded-[2px] bg-sb-active-fg" style={{ width: `${pct}%` }} />
    </span>
  )
}

export function Thumb({
  look,
  tier,
  url,
  pct,
  aspectRatio,
}: {
  look: BlockLook
  tier: BlockTier
  url: string | null
  pct: number
  aspectRatio: AspectRatio
}) {
  // The project's own aspect ratio, fitted inside the tier's square - never a fixed shape.
  const box = thumbBox(aspectRatio, tier === 'wide' ? THUMB_EDGE_WIDE_PX : THUMB_EDGE_NARROW_PX)
  const size = { width: box.width, height: box.height }
  const base = 'flex flex-none items-center justify-center self-center overflow-hidden rounded-[3px] border'
  if ((look === 'ready' || look === 'stale') && url) {
    return (
      <span
        data-testid="shot-thumb"
        data-src={url}
        className={`${base} bg-cover bg-center ${look === 'stale' ? 'border-status-stale-line' : 'border-border-muted'}`}
        style={{ ...size, backgroundImage: `url("${url}")` }}
      />
    )
  }
  if (look === 'generating') {
    return (
      <span className={`${base} border-border-strong bg-bg-well`} style={size}>
        <ProgressRule pct={pct} className={tier === 'wide' ? 'w-[18px]' : 'w-[10px]'} />
      </span>
    )
  }
  if (look === 'failed') return <span className={`${base} border-dashed border-status-failed-line bg-bg-well`} style={size} />
  return (
    <span data-testid="shot-thumb-empty" className={`${base} border-dashed border-border-muted text-body text-text-quiet`} style={size} aria-hidden>
      ?
    </span>
  )
}

function stop(e: MouseEvent | KeyboardEvent) {
  e.stopPropagation()
}

// One shot in the picture lane. Width comes from its duration (the caller sizes the slot); the
// tier decides how much it can say without truncating anything essential. Below 112px the
// text lives in the tooltip and the inspect panel; action prices move into the tooltip too.
// Focused, Alt+←/→ moves it one place and Delete/Backspace removes it to the bin; dragging
// it is handled by the lane (use-lane-drag).
export const ShotBlock = memo(function ShotBlock({
  shot,
  status,
  tier,
  selected,
  busy,
  readOnly,
  price,
  now,
  aspectRatio,
  onSelect,
  onGenerate,
  onMove,
  onRemove,
}: {
  shot: StoryboardShot
  status: ShotImageStatus
  tier: BlockTier
  selected: boolean
  busy: boolean
  readOnly: boolean
  price: number
  now: number | null
  aspectRatio: AspectRatio
  onSelect: (shotId: string) => void
  onGenerate: (shotId: string) => void
  onMove: (shotId: string, direction: 1 | -1) => void
  onRemove: (shotId: string) => void
}) {
  const look = lookFor(status.state)
  const number = shot.order_index + 1
  const name = blockText(shot)
  const duration = formatSeconds(filmDuration(shot))
  const eta = look === 'generating' ? etaFor(status.startedAt, status.queuedAt, now) : null
  const url = status.thumbUrl ?? status.imageUrl
  const fill = tier === 'fill'
  const imageFill = fill && (look === 'ready' || look === 'stale') && url
  const priceText = `${formatCredits(price)} cr`
  const actionDisabled = busy || readOnly

  const actionLabel = look === 'failed' ? 'Retry' : 'Generate'
  const actionTitle = `${look === 'failed' ? 'Retry this frame' : 'Generate this frame'} · ${formatCredits(price)} ${
    price === 1 ? 'credit' : 'credits'
  }`

  function action() {
    if (look !== 'failed' && look !== 'not_generated') return null
    const showPrice = tier === 'wide'
    const text = tier === 'wide' ? actionLabel : look === 'failed' ? (fill ? '↻' : 'Retry') : '+'
    const tone =
      look === 'failed'
        ? 'border-status-failed-line text-status-failed-fg hover:bg-status-failed-bg-hover'
        : 'border-border-strong bg-bg-canvas text-text-primary hover:border-border-strong-hover'
    return (
      <button
        type="button"
        data-testid="shot-action"
        title={actionTitle}
        aria-label={actionTitle}
        disabled={actionDisabled}
        onClick={(e) => {
          stop(e)
          onGenerate(shot.id)
        }}
        onKeyDown={stop}
        className={`flex h-[20px] flex-none cursor-pointer items-center gap-[4px] whitespace-nowrap rounded-badge border px-[6px] text-chip leading-none font-medium disabled:cursor-not-allowed disabled:opacity-60 ${tone}`}
      >
        {text}
        {showPrice && <span className="font-mono font-normal">{priceText}</span>}
      </button>
    )
  }

  // The one datum a narrow block carries, or the full second row of a wide one.
  function datum() {
    if (look === 'generating' && eta) {
      return (
        <>
          <ProgressRule pct={eta.pct} className="min-w-[20px] flex-1" />
          <span className="flex-none whitespace-nowrap font-mono text-mono text-sb-active-fg">{eta.label}</span>
        </>
      )
    }
    if (look === 'failed' || look === 'not_generated') return action()
    return (
      <>
        <span className="whitespace-nowrap font-mono text-mono text-text-tertiary">{duration}</span>
        {look === 'stale' && tier === 'wide' && (
          <span className="whitespace-nowrap rounded-badge border border-status-stale-line bg-status-stale-bg px-[5px] text-chip font-medium uppercase tracking-label text-status-stale-fg">
            Stale
          </span>
        )}
      </>
    )
  }

  const style: CSSProperties | undefined = imageFill
    ? { backgroundImage: `url("${url}")`, backgroundSize: 'cover', backgroundPosition: 'center' }
    : undefined

  return (
    <div
      role="button"
      tabIndex={0}
      data-testid="shot-block"
      data-shot-id={shot.id}
      data-state={status.state}
      data-tier={tier}
      data-selected={selected ? 'true' : 'false'}
      aria-pressed={selected}
      aria-label={`Shot ${number}`}
      onClick={() => onSelect(shot.id)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onSelect(shot.id)
        } else if (!readOnly && e.altKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
          e.preventDefault()
          onMove(shot.id, e.key === 'ArrowRight' ? 1 : -1)
        } else if (!readOnly && (e.key === 'Delete' || e.key === 'Backspace')) {
          e.preventDefault()
          onRemove(shot.id)
        }
      }}
      className={`relative flex h-[62px] min-w-0 flex-1 cursor-pointer items-stretch gap-[7px] overflow-hidden rounded-badge border p-[5px_7px_5px_5px] outline-offset-2 hover:border-border-strong-hover ${
        CONTAINER[look]
      } ${selected ? 'outline-2 outline-text-primary [outline-style:solid]' : ''}`}
      style={style}
      data-src={imageFill ? url : undefined}
    >
      {!fill && <Thumb look={look} tier={tier} url={url} pct={eta?.pct ?? 0} aspectRatio={aspectRatio} />}
      <span className="flex min-w-0 flex-1 flex-col justify-between py-[1px]">
        <span className="flex min-w-0 items-center gap-[5px]">
          <span
            className={`flex-none font-mono text-mono ${NUMBER_INK[look]} ${fill ? 'rounded-[3px] bg-bg-canvas px-[3px]' : ''}`}
          >
            {number}
          </span>
          {tier === 'wide' && (
            <span
              data-testid="shot-block-text"
              className={`min-w-0 overflow-hidden text-ellipsis whitespace-nowrap text-meta ${
                selected ? 'text-text-primary' : NAME_INK[look]
              }`}
            >
              {name}
            </span>
          )}
        </span>
        {!(fill && look !== 'failed' && look !== 'not_generated') && (
          <span className="flex min-w-0 items-center gap-[5px]">{fill ? action() : datum()}</span>
        )}
      </span>
    </div>
  )
})
