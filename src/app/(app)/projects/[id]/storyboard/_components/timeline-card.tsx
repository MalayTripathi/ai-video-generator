'use client'

import { memo, useCallback, useLayoutEffect, useRef, useState, type KeyboardEvent, type RefObject } from 'react'
import {
  FIT_COLLAPSE_BREAKPOINT_PX,
  RETIME_SNAP_SEC,
  STORYBOARD_ZOOM_STEPS,
} from '@/lib/config/storyboard'
import { speechBars } from '@/lib/storyboard/voiceover'
import {
  blockTier,
  filmDuration,
  filmSeconds,
  formatTimecode,
  groupBands,
  LANE_GUTTER_PX,
  laneLayout,
  laneTotalSeconds,
  retimeBounds,
  rulerTicks,
  snapRetime,
  ZERO_BLOCK_PX,
} from '@/lib/storyboard/timeline'
import { FORCED_CUT_REASON, type ResolvedJoin } from '@/lib/storyboard/motion'
import { imagePrice, useStoryboard, type TimelineMode } from './storyboard-context'
import { ShotBlock } from './shot-block'
import { MotionBlock } from './motion-block'
import type { MotionSegment } from '../actions'
import { BinControl } from './bin-control'
import { FitButton } from './fit-button'
import { Playhead, type PlayheadHandle } from './playhead'
import { useLaneDrag } from './use-lane-drag'
import { useNow } from './use-now'

function useElementWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null)
  const [width, setWidth] = useState<number | null>(null)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    setWidth(el.clientWidth)
    const observer = new ResizeObserver(() => setWidth(el.clientWidth))
    observer.observe(el)
    return () => observer.disconnect()
  }, [])
  return { ref, width }
}

// A boundary between two shots, or the end handle after the last. Dragging it (use-lane-
// drag) or pressing ←/→ while it has focus sets the length of the shot on its left.
const Grip = memo(function Grip({
  shotId,
  number,
  seconds,
  min,
  max,
  end,
  onNudge,
}: {
  shotId: string
  number: number
  seconds: number
  min: number | null
  max: number | null
  end: boolean
  onNudge: (shotId: string, direction: 1 | -1) => void
}) {
  const enabled = min !== null && max !== null
  function onKeyDown(e: KeyboardEvent) {
    if (!enabled || e.altKey || (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight')) return
    e.preventDefault()
    onNudge(shotId, e.key === 'ArrowRight' ? 1 : -1)
  }
  return (
    <span
      data-grip
      data-testid="shot-grip"
      data-shot-id={shotId}
      role="slider"
      tabIndex={enabled ? 0 : -1}
      aria-label={`Length of shot ${number}`}
      aria-orientation="horizontal"
      aria-valuenow={seconds}
      aria-valuemin={min ?? undefined}
      aria-valuemax={max ?? undefined}
      aria-valuetext={`${seconds.toFixed(1)}s`}
      aria-disabled={!enabled}
      title={enabled ? 'Drag to hold this shot longer or shorter' : undefined}
      onKeyDown={onKeyDown}
      className={`group flex flex-none touch-none items-center justify-center rounded-badge outline-offset-[-2px] focus-visible:outline-2 focus-visible:outline-text-primary focus-visible:[outline-style:solid] ${
        enabled ? 'cursor-col-resize hover:bg-bg-inset' : ''
      } ${end ? 'absolute bottom-0 right-0 top-0 z-[5] w-[8px]' : 'w-[34px]'}`}
    >
      {!end && (
        <span className="flex gap-[2px] group-hover:gap-[3px]" aria-hidden>
          <span className="block h-[26px] w-px bg-border-strong" />
          <span className="block h-[26px] w-px bg-border-strong" />
        </span>
      )}
    </span>
  )
})

function LaneLabel({ children, className = '' }: { children?: string; className?: string }) {
  return <span className={`flex w-[44px] flex-none items-center text-meta text-text-tertiary ${className}`}>{children}</span>
}

// In Motion & transitions mode the boundary gutter holds the join's transition chip instead
// of a grip - same 34px, so switching modes never moves a shot. "Cut" fits the gutter;
// "Dissolve" does not, so it shows its glyph. A forced cut reads Cut and says why.
const JoinChip = memo(function JoinChip({
  join,
  from,
  to,
  selected,
  onSelect,
}: {
  join: ResolvedJoin
  from: number
  to: number
  selected: boolean
  onSelect: (shotId: string) => void
}) {
  const dissolve = join.transition === 'dissolve'
  const label = dissolve ? 'Dissolve' : 'Cut'
  return (
    <span className="flex w-[34px] flex-none items-center justify-center">
      <button
        type="button"
        data-testid="join-chip"
        data-shot-id={join.shotId}
        data-transition={join.transition}
        data-forced={join.forced ? 'true' : undefined}
        aria-pressed={selected}
        aria-label={`Join ${from} to ${to}: ${label}`}
        title={join.forced ? `Cut · ${FORCED_CUT_REASON}` : label}
        onClick={(e) => {
          e.stopPropagation()
          onSelect(join.shotId)
        }}
        className={`cursor-pointer whitespace-nowrap rounded-badge border px-[5px] py-px text-chip outline-offset-2 ${
          dissolve ? 'border-text-primary bg-bg-canvas text-text-primary' : 'border-border-subtle bg-bg-inset text-text-tertiary'
        } ${selected ? 'outline-2 outline-text-primary [outline-style:solid]' : ''}`}
      >
        {dissolve ? '◇' : 'Cut'}
      </button>
    </span>
  )
})

// The mode control (canvas 15b / 15d): two ways of touching one strip.
function ModeToggle() {
  const { mode, setMode } = useStoryboard()
  const item = (value: TimelineMode) =>
    `flex h-[30px] cursor-pointer items-center gap-[7px] whitespace-nowrap px-[12px] text-small ${
      mode === value ? 'bg-bg-inset font-medium text-text-primary' : 'text-text-secondary hover:bg-bg-inset'
    }`
  return (
    <div
      role="group"
      aria-label="Timeline mode"
      className="flex h-[30px] flex-none items-center overflow-hidden rounded-control border border-border-strong"
    >
      <button type="button" aria-pressed={mode === 'retime'} onClick={() => setMode('retime')} className={item('retime')}>
        <svg width="12" height="10" viewBox="0 0 12 10" fill="none" aria-hidden="true">
          <path d="M1 1v8M11 1v8M3 5h6M4.6 3.4 3 5l1.6 1.6M7.4 3.4 9 5 7.4 6.6" stroke="currentColor" strokeWidth="1.2" />
        </svg>
        Retime
      </button>
      <button
        type="button"
        aria-pressed={mode === 'motion'}
        onClick={() => setMode('motion')}
        className={`${item('motion')} border-l border-border-subtle`}
      >
        <svg width="12" height="10" viewBox="0 0 12 10" fill="none" aria-hidden="true">
          <rect x="0.6" y="1.6" width="5" height="6.8" rx="1" stroke="currentColor" strokeWidth="1.2" />
          <path d="M7.4 5h4M9.8 3.2 11.6 5 9.8 6.8" stroke="currentColor" strokeWidth="1.2" />
        </svg>
        Motion &amp; transitions
      </button>
    </div>
  )
}

const ZOOM_BUTTON =
  'flex h-[28px] cursor-pointer items-center justify-center text-text-secondary hover:bg-bg-inset hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent'

function ZoomControls() {
  const { zoomIndex, setZoomIndex } = useStoryboard()
  const last = STORYBOARD_ZOOM_STEPS.length - 1
  return (
    <div
      data-testid="zoom-controls"
      className="flex h-[28px] flex-none items-center overflow-hidden rounded-control border border-border-subtle"
    >
      <button
        type="button"
        aria-label="Zoom out"
        disabled={zoomIndex === 0}
        onClick={() => setZoomIndex(Math.max(0, zoomIndex - 1))}
        className={`${ZOOM_BUTTON} w-[28px]`}
      >
        <svg width="10" height="2" viewBox="0 0 10 2" fill="none" aria-hidden="true">
          <rect width="10" height="1.4" fill="currentColor" />
        </svg>
      </button>
      <button
        type="button"
        aria-label="Fit"
        aria-pressed={zoomIndex === 0}
        onClick={() => setZoomIndex(0)}
        className={`${ZOOM_BUTTON} border-x border-border-subtle px-[9px] text-small ${
          zoomIndex === 0 ? 'text-text-primary' : ''
        }`}
      >
        Fit
      </button>
      <button
        type="button"
        aria-label="Zoom in"
        disabled={zoomIndex === last}
        onClick={() => setZoomIndex(Math.min(last, zoomIndex + 1))}
        className={`${ZOOM_BUTTON} w-[28px]`}
      >
        <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden="true">
          <rect x="4.3" width="1.4" height="10" fill="currentColor" />
          <rect y="4.3" width="10" height="1.4" fill="currentColor" />
        </svg>
      </button>
    </div>
  )
}

// The committed Total is React's; while a boundary is dragged the drag hides it and writes
// the pending length into the second span directly (canvas: primary ink + a pending mark).
function TimelineHeader({
  totalSeconds,
  totalRef,
  pendingRef,
}: {
  totalSeconds: number
  totalRef: RefObject<HTMLSpanElement | null>
  pendingRef: RefObject<HTMLSpanElement | null>
}) {
  const { ref, width } = useElementWidth<HTMLDivElement>()
  return (
    <div ref={ref} className="flex items-center gap-[12px] border-b border-border-subtle p-[11px_14px]">
      <ModeToggle />
      <ZoomControls />

      <span ref={totalRef} data-testid="timeline-total" className="font-mono text-mono text-text-tertiary">
        Total {formatTimecode(totalSeconds)} · provisional
      </span>
      <span ref={pendingRef} hidden data-testid="timeline-total-pending" className="items-center gap-[8px]">
        <span className="font-mono text-mono text-text-primary">
          Total <span data-pending-total />
        </span>
        <span className="ml-[8px] rounded-badge bg-bg-inset px-[6px] text-chip uppercase tracking-label text-text-tertiary">
          pending
        </span>
      </span>
      <span className="flex-1" />
      {/* The right-aligned end cluster: Bin sits left of Fit to voiceover, so appearing grows
          leftwards into free space and moves no other control. */}
      <BinControl />
      <FitButton compact={width !== null && width < FIT_COLLAPSE_BREAKPOINT_PX} />
    </div>
  )
}

// The voice lane (canvas 15b): the read's waveform across the time it covers, drawn from
// its spans; "No voiceover yet" until one lands. Muted reads draw faded.
function VoiceLane({ totalSeconds }: { totalSeconds: number }) {
  const { voiceover } = useStoryboard()
  const current = voiceover.current
  if (!current) {
    return (
      <span
        data-testid="voice-lane"
        className="flex h-[30px] items-center overflow-hidden rounded-badge border border-border-muted bg-bg-well px-[6px]"
      >
        <span className="pl-[4px] text-meta text-text-quiet">No voiceover yet</span>
      </span>
    )
  }
  const extent = Math.max(totalSeconds, current.durationSec)
  const widthPct = extent > 0 ? (current.durationSec / extent) * 100 : 100
  const bars = speechBars(current.spans, current.durationSec, 62)
  return (
    <span
      data-testid="voice-lane"
      data-muted={current.muted}
      className="flex h-[30px] items-center overflow-hidden rounded-badge border border-transparent bg-ident-voiceover-bg px-[6px]"
    >
      <span className={`flex h-full items-center gap-[2px] ${current.muted ? 'opacity-40' : ''}`} style={{ width: `${widthPct}%` }}>
        {bars.map((b, i) => (
          <span key={i} className="flex-1 rounded-[1px] bg-ident-voiceover-fg opacity-60" style={{ height: b.h }} />
        ))}
      </span>
    </span>
  )
}

// The timeline card (canvas 15a/15b/15c): header, scene bands, ruler, the editable picture
// lane, the two audio lanes and the playhead. Shots are as wide as they are long; bands,
// ruler, lane and playhead scroll together when zoomed past Fit.
export function TimelineCard() {
  const {
    laneShots,
    statusFor,
    selectedShotId,
    select,
    busyShotIds,
    readOnly,
    polling,
    generate,
    aspectRatio,
    zoomIndex,
    retimeMaxSec,
    retime,
    reorder,
    setBinned,
    mode,
    motions,
    joins,
    selectedSegment,
    selectSegment,
    selectedJoinShotId,
    selectJoin,
    setSplit,
  } = useStoryboard()
  const motionMode = mode === 'motion'
  const now = useNow(polling)
  const { ref: scrollerRef, width: laneWidth } = useElementWidth<HTMLDivElement>()
  const tooltipRef = useRef<HTMLSpanElement>(null)
  const totalRef = useRef<HTMLSpanElement>(null)
  const pendingRef = useRef<HTMLSpanElement>(null)
  const playheadRef = useRef<PlayheadHandle>(null)

  const total = laneTotalSeconds(laneShots)
  const bands = groupBands(laneShots)
  const ticks = rulerTicks(total)
  const price = imagePrice(1)
  const zoom = STORYBOARD_ZOOM_STEPS[zoomIndex] ?? 1
  const zoomed = zoomIndex > 0

  // Fit by default, filling the lane; zoom scales the Fit scale up. Before the lane is
  // measured (first paint) there is no layout: slots flex by duration rather than guess.
  const layout =
    laneWidth === null ? null : laneLayout(laneWidth, laneShots.map(filmSeconds), zoom)
  const spanStyle = layout ? { flex: 'none', width: layout.contentWidth } : undefined

  const { onPointerDown, consumeClick } = useLaneDrag({
    // Boundary drags and reordering belong to Retime; Motion mode starts neither.
    inputs: { layout, laneShots, totalSeconds: total, retimeMaxSec, readOnly: readOnly || motionMode, retime, reorder },
    scrollerRef,
    tooltipRef,
    totalRef,
    pendingRef,
  })

  // Stable handlers for the memo'd blocks and grips; they read the lane through a ref.
  const laneRef = useRef(laneShots)
  useLayoutEffect(() => {
    laneRef.current = laneShots
  }, [laneShots])

  const onGenerate = useCallback((shotId: string) => void generate([shotId], 'lane'), [generate])
  const onSelect = useCallback(
    (shotId: string) => {
      if (!consumeClick()) select(shotId)
    },
    [consumeClick, select]
  )
  const onMove = useCallback(
    (shotId: string, direction: 1 | -1) => {
      const index = laneRef.current.findIndex((s) => s.id === shotId)
      if (index >= 0) reorder(shotId, index + direction)
    },
    [reorder]
  )
  const onRemove = useCallback((shotId: string) => setBinned(shotId, true), [setBinned])
  const onSelectSegment = useCallback(
    (shotId: string, segment: MotionSegment) => selectSegment({ shotId, segment }),
    [selectSegment]
  )
  const onMoveSplit = useCallback((shotId: string, at: number) => setSplit(shotId, at), [setSplit])
  const joinByShot = new Map(joins.map((j) => [j.shotId, j]))
  const onNudge = useCallback(
    (shotId: string, direction: 1 | -1) => {
      const shot = laneRef.current.find((s) => s.id === shotId)
      if (!shot) return
      const committed = filmDuration(shot)
      const bounds = retimeBounds(retimeMaxSec, committed)
      if (!bounds) return
      retime(shotId, snapRetime((committed ?? 0) + direction * RETIME_SNAP_SEC, bounds))
    },
    [retime, retimeMaxSec]
  )

  return (
    <div className="flex flex-col rounded-frame border border-border-strong bg-bg-canvas shadow-card">
      <TimelineHeader totalSeconds={total} totalRef={totalRef} pendingRef={pendingRef} />

      <div className="flex gap-[10px] p-[12px_14px_14px]">
        <div className="flex flex-none flex-col gap-[7px]" aria-hidden>
          <LaneLabel className="h-[18px]" />
          <LaneLabel className="h-[18px]" />
          <LaneLabel className="h-[62px]">Picture</LaneLabel>
          <LaneLabel className="h-[30px]">Voice</LaneLabel>
          <LaneLabel className="h-[30px]">Music</LaneLabel>
        </div>

        <div
          ref={scrollerRef}
          data-testid="lane-scroller"
          className={`relative min-w-0 flex-1 ${zoomed ? 'overflow-x-auto' : 'overflow-x-hidden'}`}
        >
          <div
            className="relative flex flex-col gap-[7px]"
            style={zoomed && layout ? { width: Math.max(layout.contentWidth, laneWidth ?? 0) } : undefined}
          >
            <div className="flex h-[18px] gap-[3px]" data-testid="scene-bands" style={spanStyle}>
              {bands.map((band) => (
                <div
                  key={band.firstIndex}
                  data-testid="scene-band"
                  style={{ flex: `${band.seconds} 1 0` }}
                  className="flex h-[18px] min-w-0 items-center overflow-hidden whitespace-nowrap rounded-badge bg-bg-inset px-[8px] text-label uppercase tracking-label text-text-tertiary"
                >
                  {band.name}
                </div>
              ))}
            </div>

            <div
              className="relative h-[18px] cursor-pointer border-b border-border-subtle"
              data-testid="ruler"
              style={spanStyle}
              onPointerDown={(e) => playheadRef.current?.startScrub(e, true)}
            >
              {ticks.map((tick, i) => (
                <span
                  key={tick.label + i}
                  className="pointer-events-none absolute bottom-[3px] select-none font-mono text-mono text-text-quiet"
                  style={
                    i === ticks.length - 1
                      ? { right: 0 }
                      : i === 0
                        ? { left: 0 }
                        : { left: `${tick.pct}%`, transform: 'translateX(-50%)' }
                  }
                >
                  {tick.label}
                </span>
              ))}
            </div>

            <div
              className="relative flex h-[62px] select-none items-stretch"
              data-testid="picture-lane"
              data-layout={layout ? 'measured' : 'pending'}
              onPointerDown={onPointerDown}
            >
              {laneShots.map((shot, i) => {
                const last = i === laneShots.length - 1
                const seconds = filmSeconds(shot)
                const bounds = retimeBounds(retimeMaxSec, filmDuration(shot))
                const join = joinByShot.get(shot.id)
                const grip = motionMode ? (
                  join ? (
                    <JoinChip
                      join={join}
                      from={shot.order_index + 1}
                      to={laneShots[i + 1].order_index + 1}
                      selected={selectedJoinShotId === shot.id}
                      onSelect={selectJoin}
                    />
                  ) : null
                ) : (
                  <Grip
                    shotId={shot.id}
                    number={shot.order_index + 1}
                    seconds={seconds}
                    min={readOnly ? null : (bounds?.min ?? null)}
                    max={readOnly ? null : (bounds?.max ?? null)}
                    end={last}
                    onNudge={onNudge}
                  />
                )
                return (
                  <div
                    key={shot.id}
                    data-testid="shot-slot"
                    data-shot-id={shot.id}
                    className="relative flex min-w-0 items-stretch will-change-transform"
                    style={
                      layout
                        ? { flex: 'none', width: layout.blocks[i] + (last ? 0 : LANE_GUTTER_PX) }
                        : {
                            flex: `${seconds} 1 0`,
                            minWidth: seconds === 0 ? ZERO_BLOCK_PX + (last ? 0 : LANE_GUTTER_PX) : 0,
                          }
                    }
                  >
                    {motionMode ? (
                      <MotionBlock
                        shot={shot}
                        status={statusFor(shot.id)}
                        resolved={motions.get(shot.id)}
                        blockPx={seconds === 0 ? ZERO_BLOCK_PX : layout ? layout.blocks[i] : null}
                        selectedSegment={selectedSegment?.shotId === shot.id ? selectedSegment.segment : null}
                        readOnly={readOnly}
                        aspectRatio={aspectRatio}
                        onSelect={onSelectSegment}
                        onRemove={onRemove}
                        onMoveSplit={onMoveSplit}
                      />
                    ) : (
                      <ShotBlock
                        shot={shot}
                        status={statusFor(shot.id)}
                        tier={seconds === 0 ? 'fill' : layout ? blockTier(layout.blocks[i]) : 'wide'}
                        selected={selectedShotId === shot.id}
                        busy={busyShotIds.has(shot.id)}
                        readOnly={readOnly}
                        price={price}
                        now={now}
                        aspectRatio={aspectRatio}
                        onSelect={onSelect}
                        onGenerate={onGenerate}
                        onMove={onMove}
                        onRemove={onRemove}
                      />
                    )}
                    {grip}
                  </div>
                )
              })}
              <span
                ref={tooltipRef}
                hidden
                data-testid="retime-tooltip"
                className="pointer-events-none absolute top-[-30px] z-20 -translate-x-1/2 whitespace-nowrap rounded-badge bg-text-primary px-[6px] py-[2px] font-mono text-mono text-bg-canvas"
              />
            </div>

            <VoiceLane totalSeconds={total} />

            <span className="flex h-[30px] items-center overflow-hidden rounded-badge bg-bg-inset px-[6px]">
              <span className="pl-[4px] text-meta text-text-quiet">No music yet</span>
            </span>

            <Playhead ref={playheadRef} totalSeconds={total} contentWidth={layout?.contentWidth ?? null} scrollerRef={scrollerRef} />
          </div>
        </div>
      </div>

      <div className="flex items-center gap-[10px] border-t border-border-subtle p-[10px_14px]">
        {motionMode ? (
          <>
            <span className="flex-1 text-meta text-text-tertiary">
              Click a shot for its motion, a join for its transition. Split divides one shot into two motion segments of the
              same image; Delete sends a shot to the bin.
            </span>
            <span className="text-meta text-text-quiet">Motion and transitions are free and mark nothing stale.</span>
          </>
        ) : (
          <>
            <span className="flex-1 text-meta text-text-tertiary">
              Drag a boundary to hold a shot longer. Drag a shot to reorder it. Remove sends a shot to the bin, where Restore
              puts it back in its original position.
            </span>
            <span className="text-meta text-text-quiet">Retiming, reordering and removing are free and mark nothing stale.</span>
          </>
        )}
      </div>
    </div>
  )
}
