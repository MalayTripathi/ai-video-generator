'use client'

import { memo, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react'
import type { AspectRatio } from '@/lib/config/enums'
import { RETIME_SNAP_SEC } from '@/lib/config/storyboard'
import { MOTION_GLYPHS, MOTION_LABELS } from '@/lib/motion-labels'
import { clampSplit, type ResolvedMotion } from '@/lib/storyboard/motion'
import { blockTier, filmSeconds, NARROW_SHOT_PX } from '@/lib/storyboard/timeline'
import type { MotionSegment } from '../actions'
import { blockText, CONTAINER, formatSeconds, lookFor, NAME_INK, NUMBER_INK, Thumb } from './shot-block'
import type { ShotImageStatus, StoryboardShot } from './types'

// One shot in Motion & transitions mode (canvas 15d). Same slot, same width as in Retime;
// its duration chip becomes a motion chip. A split draws inside the block as a dashed
// marker between two segments of the same image - never a gutter, so the lane never moves.
// The marker drags (and nudges with ←/→) to move the split, clamped per segment.
export const MotionBlock = memo(function MotionBlock({
  shot,
  status,
  resolved,
  blockPx,
  selectedSegment,
  readOnly,
  aspectRatio,
  onSelect,
  onRemove,
  onMoveSplit,
}: {
  shot: StoryboardShot
  status: ShotImageStatus
  resolved: ResolvedMotion | undefined
  /** The block's drawn width; null before the lane is measured. */
  blockPx: number | null
  selectedSegment: MotionSegment | null
  readOnly: boolean
  aspectRatio: AspectRatio
  onSelect: (shotId: string, segment: MotionSegment) => void
  onRemove: (shotId: string) => void
  onMoveSplit: (shotId: string, splitAt: number) => void
}) {
  const containerRef = useRef<HTMLDivElement>(null)
  const [dragAt, setDragAt] = useState<number | null>(null)
  const look = lookFor(status.state)
  const seconds = filmSeconds(shot)
  const number = shot.order_index + 1
  const name = blockText(shot)
  const url = status.thumbUrl ?? status.imageUrl
  const splitAt = dragAt ?? resolved?.splitAt ?? null

  function segmentPane(segment: MotionSegment, fraction: number) {
    const motion = segment === 'a' ? resolved?.motion : resolved?.splitMotion
    const label = splitAt !== null ? `${number}${segment}` : String(number)
    const px = blockPx === null ? null : blockPx * fraction
    const tier = px === null ? 'wide' : blockTier(px)
    const motionText = motion ? (px === null || px >= NARROW_SHOT_PX ? MOTION_LABELS[motion] : MOTION_GLYPHS[motion]) : ''
    const selected = selectedSegment === segment
    const length = formatSeconds(splitAt === null ? seconds : Math.round(seconds * fraction * 10) / 10)
    return (
      <div
        role="button"
        tabIndex={0}
        data-testid="motion-segment"
        data-segment={segment}
        data-shot-id={shot.id}
        data-motion={motion}
        aria-pressed={selected}
        aria-label={`Shot ${label}`}
        data-length={length}
        onClick={(e) => {
          e.stopPropagation()
          onSelect(shot.id, segment)
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            onSelect(shot.id, segment)
          } else if (!readOnly && (e.key === 'Delete' || e.key === 'Backspace')) {
            e.preventDefault()
            onRemove(shot.id)
          }
        }}
        style={{ width: `${fraction * 100}%` }}
        className={`relative flex h-full min-w-0 flex-none cursor-pointer items-stretch gap-[7px] overflow-hidden rounded-[3px] p-[5px_7px_5px_5px] outline-offset-[-2px] ${
          selected ? 'outline-2 outline-text-primary [outline-style:solid]' : ''
        }`}
      >
        {tier !== 'fill' && <Thumb look={look} tier={tier} url={url} pct={0} aspectRatio={aspectRatio} />}
        <span className="flex min-w-0 flex-1 flex-col justify-between py-[1px]">
          <span className="flex min-w-0 items-center gap-[5px]">
            <span className={`flex-none font-mono text-mono ${NUMBER_INK[look]}`}>{label}</span>
            {tier === 'wide' && (
              <span
                className={`min-w-0 overflow-hidden text-ellipsis whitespace-nowrap text-meta ${
                  selected ? 'text-text-primary' : NAME_INK[look]
                }`}
              >
                {name}
              </span>
            )}
          </span>
          {motion && (
            <span className="flex min-w-0 items-center">
              <span
                data-testid="motion-chip"
                className={`whitespace-nowrap rounded-badge bg-bg-inset px-[6px] py-px text-chip ${
                  selected ? 'text-text-primary' : 'text-text-tertiary'
                }`}
              >
                {motionText}
              </span>
            </span>
          )}
        </span>
      </div>
    )
  }

  function fractionAt(clientX: number): number | null {
    const rect = containerRef.current?.getBoundingClientRect()
    if (!rect || rect.width <= 0) return null
    return clampSplit((clientX - rect.left) / rect.width, seconds)
  }

  // The drag's live value sits in a ref as well as state: pointerup and the capture loss
  // that follows it both end the drag, and only the first may commit.
  const dragging = useRef<number | null>(null)
  function setDrag(at: number | null) {
    dragging.current = at
    setDragAt(at)
  }

  function onMarkerDown(e: PointerEvent<HTMLSpanElement>) {
    if (readOnly || e.button !== 0) return
    e.preventDefault()
    e.stopPropagation()
    e.currentTarget.setPointerCapture?.(e.pointerId)
    e.currentTarget.focus()
    setDrag(fractionAt(e.clientX) ?? resolved?.splitAt ?? null)
  }

  function onMarkerMove(e: PointerEvent<HTMLSpanElement>) {
    if (dragging.current === null) return
    const at = fractionAt(e.clientX)
    if (at !== null) setDrag(at)
  }

  function onMarkerUp() {
    const at = dragging.current
    if (at === null) return
    setDrag(null)
    if (at !== resolved?.splitAt) onMoveSplit(shot.id, at)
  }

  function onMarkerKey(e: KeyboardEvent<HTMLSpanElement>) {
    if (e.key === 'Escape' && dragging.current !== null) {
      e.preventDefault()
      setDrag(null)
      return
    }
    if (readOnly || splitAt === null || (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight')) return
    e.preventDefault()
    e.stopPropagation()
    const step = RETIME_SNAP_SEC / Math.max(seconds, RETIME_SNAP_SEC)
    const next = clampSplit(splitAt + (e.key === 'ArrowRight' ? step : -step), seconds)
    if (next !== null && next !== splitAt) onMoveSplit(shot.id, next)
  }

  return (
    <div
      ref={containerRef}
      data-testid="shot-block"
      data-mode="motion"
      data-shot-id={shot.id}
      data-state={status.state}
      data-split={splitAt ?? undefined}
      className={`relative flex h-[62px] min-w-0 flex-1 items-stretch overflow-hidden rounded-badge border hover:border-border-strong-hover ${CONTAINER[look]}`}
    >
      {splitAt === null ? (
        segmentPane('a', 1)
      ) : (
        <>
          {segmentPane('a', splitAt)}
          {segmentPane('b', 1 - splitAt)}
          <span
            data-testid="split-marker"
            data-shot-id={shot.id}
            role="slider"
            tabIndex={readOnly ? -1 : 0}
            aria-label={`Split point of shot ${number}`}
            aria-orientation="horizontal"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(splitAt * 100)}
            aria-valuetext={`${(seconds * splitAt).toFixed(1)}s`}
            aria-disabled={readOnly}
            title={readOnly ? undefined : 'Drag to move the split'}
            onPointerDown={onMarkerDown}
            onPointerMove={onMarkerMove}
            onPointerUp={onMarkerUp}
            onPointerCancel={() => setDrag(null)}
            onLostPointerCapture={onMarkerUp}
            onClick={(e) => e.stopPropagation()}
            onKeyDown={onMarkerKey}
            style={{ left: `${splitAt * 100}%` }}
            className={`absolute bottom-0 top-0 z-[2] flex w-[12px] -translate-x-1/2 touch-none justify-center outline-offset-[-2px] focus-visible:outline-2 focus-visible:outline-text-primary focus-visible:[outline-style:solid] ${
              readOnly ? '' : 'cursor-col-resize'
            }`}
          >
            <span className="block h-full w-0 border-l border-dashed border-border-strong-hover" aria-hidden />
          </span>
        </>
      )}
    </div>
  )
})
