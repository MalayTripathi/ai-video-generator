'use client'

import { useCallback, useLayoutEffect, useRef, useState } from 'react'
import { STORYBOARD_MAX_BLOCK_PX } from '@/lib/config/storyboard'
import {
  blockTier,
  formatTimecode,
  groupBands,
  LANE_GUTTER_PX,
  laneLayout,
  laneTotalSeconds,
  rulerTicks,
  shotSeconds,
  ZERO_BLOCK_PX,
} from '@/lib/storyboard/timeline'
import { imagePrice, useStoryboard } from './storyboard-context'
import { ShotBlock } from './shot-block'
import { useNow } from './use-now'

function useElementWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null)
  const [width, setWidth] = useState<number | null>(null)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    setWidth(el.getBoundingClientRect().width)
    const observer = new ResizeObserver((entries) => setWidth(entries[0].contentRect.width))
    observer.observe(el)
    return () => observer.disconnect()
  }, [])
  return { ref, width }
}

// static until retime - the drag handle is drawn, never wired
function Grip() {
  return (
    <span className="flex w-[34px] flex-none items-center justify-center" aria-hidden>
      <span className="flex gap-[2px]">
        <span className="block h-[26px] w-px bg-border-strong" />
        <span className="block h-[26px] w-px bg-border-strong" />
      </span>
    </span>
  )
}

// static until preview - the shared playhead, parked at zero
function Playhead() {
  return (
    <span className="absolute bottom-[14px] left-[68px] top-[42px] block w-px bg-text-primary" aria-hidden>
      <span className="absolute left-[-4px] top-[-5px] block h-[9px] w-[9px] rounded-[2px] bg-text-primary" />
    </span>
  )
}

function LaneLabel({ children }: { children?: string }) {
  return <span className="flex w-[44px] flex-none items-center text-meta text-text-tertiary">{children}</span>
}

// static until retime - the mode control, Retime shown active
function ModeToggle() {
  return (
    <div className="flex h-[30px] flex-none items-center overflow-hidden rounded-control border border-border-strong">
      <span className="flex h-[30px] cursor-pointer items-center gap-[7px] whitespace-nowrap bg-bg-inset px-[12px] text-small font-medium text-text-primary">
        <svg width="12" height="10" viewBox="0 0 12 10" fill="none" aria-hidden="true">
          <path d="M1 1v8M11 1v8M3 5h6M4.6 3.4 3 5l1.6 1.6M7.4 3.4 9 5 7.4 6.6" stroke="currentColor" strokeWidth="1.2" />
        </svg>
        Retime
      </span>
      <span className="flex h-[30px] cursor-pointer items-center gap-[7px] whitespace-nowrap border-l border-border-subtle px-[12px] text-small text-text-secondary">
        <svg width="12" height="10" viewBox="0 0 12 10" fill="none" aria-hidden="true">
          <rect x="0.6" y="1.6" width="5" height="6.8" rx="1" stroke="currentColor" strokeWidth="1.2" />
          <path d="M7.4 5h4M9.8 3.2 11.6 5 9.8 6.8" stroke="currentColor" strokeWidth="1.2" />
        </svg>
        Motion &amp; transitions
      </span>
    </div>
  )
}

// static until zoom - −/Fit/+ drawn as designed
function ZoomControls() {
  return (
    <div className="flex h-[28px] flex-none items-center overflow-hidden rounded-control border border-border-subtle">
      <span className="flex h-[28px] w-[28px] cursor-pointer items-center justify-center text-text-secondary hover:bg-bg-inset hover:text-text-primary">
        <svg width="10" height="2" viewBox="0 0 10 2" fill="none" aria-hidden="true">
          <rect width="10" height="1.4" fill="currentColor" />
        </svg>
      </span>
      <span className="flex h-[28px] cursor-pointer items-center border-x border-border-subtle px-[9px] text-small text-text-primary hover:bg-bg-inset">
        Fit
      </span>
      <span className="flex h-[28px] w-[28px] cursor-pointer items-center justify-center text-text-secondary hover:bg-bg-inset hover:text-text-primary">
        <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden="true">
          <rect x="4.3" width="1.4" height="10" fill="currentColor" />
          <rect y="4.3" width="10" height="1.4" fill="currentColor" />
        </svg>
      </span>
    </div>
  )
}

function TimelineHeader({ totalSeconds }: { totalSeconds: number }) {
  return (
    <div className="flex items-center gap-[12px] border-b border-border-subtle p-[11px_14px]">
      <ModeToggle />
      <ZoomControls />

      <span data-testid="timeline-total" className="font-mono text-mono text-text-tertiary">
        Total {formatTimecode(totalSeconds)} · provisional
      </span>
      <span className="flex-1" />
    </div>
  )
}

// The timeline card (canvas 15a): static header, scene bands, ruler, the live picture lane,
// and the two audio lanes in their empty states. Shots are as wide as they are long.
export function TimelineCard() {
  const { shots, statusFor, selectedShotId, select, busyShotIds, readOnly, polling, generate, aspectRatio } =
    useStoryboard()
  const now = useNow(polling)
  const { ref: laneRef, width: laneWidth } = useElementWidth<HTMLDivElement>()

  const total = laneTotalSeconds(shots)
  const bands = groupBands(shots)
  const ticks = rulerTicks(total)
  const price = imagePrice(1)
  const onGenerate = useCallback((shotId: string) => void generate([shotId], 'lane'), [generate])

  // Fit by default, capped per block. Before the lane is measured (first paint) there is no
  // layout: slots flex by duration and every block draws at full size rather than guess.
  const layout = laneWidth === null ? null : laneLayout(laneWidth, shots.map((s) => shotSeconds(s.duration_sec)), STORYBOARD_MAX_BLOCK_PX)
  // Bands and ruler span exactly what the blocks occupy, so all three stay aligned when the
  // cap leaves part of the lane empty.
  const spanStyle = layout ? { flex: 'none', width: layout.contentWidth } : undefined

  return (
    <div className="flex flex-col rounded-frame border border-border-strong bg-bg-canvas shadow-card">
      <TimelineHeader totalSeconds={total} />

      <div className="relative flex flex-col gap-[7px] p-[12px_14px_14px]">
        <div className="flex items-center gap-[10px]">
          <LaneLabel />
          <div className="flex flex-1 gap-[3px]" data-testid="scene-bands" style={spanStyle}>
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
        </div>

        <div className="flex items-end gap-[10px]">
          <LaneLabel />
          <div className="relative h-[18px] flex-1 border-b border-border-subtle" data-testid="ruler" style={spanStyle}>
            {ticks.map((tick, i) => (
              <span
                key={tick.label + i}
                className="absolute bottom-[3px] font-mono text-mono text-text-quiet"
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
        </div>

        <div className="flex items-stretch gap-[10px]">
          <LaneLabel>Picture</LaneLabel>
          <div
            ref={laneRef}
            className="flex min-w-0 flex-1 items-stretch"
            data-testid="picture-lane"
            data-layout={layout ? 'measured' : 'pending'}
          >
            {shots.map((shot, i) => {
              const last = i === shots.length - 1
              const seconds = shotSeconds(shot.duration_sec)
              return (
                <div
                  key={shot.id}
                  data-testid="shot-slot"
                  className="flex min-w-0 items-stretch"
                  style={
                    layout
                      ? { flex: 'none', width: layout.blocks[i] + (last ? 0 : LANE_GUTTER_PX) }
                      : { flex: `${seconds} 1 0`, minWidth: seconds === 0 ? ZERO_BLOCK_PX + (last ? 0 : LANE_GUTTER_PX) : 0 }
                  }
                >
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
                    onSelect={select}
                    onGenerate={onGenerate}
                  />
                  {!last && <Grip />}
                </div>
              )
            })}
          </div>
        </div>

        <div className="flex items-center gap-[10px]">
          <LaneLabel>Voice</LaneLabel>
          <span className="flex h-[30px] flex-1 items-center overflow-hidden rounded-badge border border-border-muted bg-bg-well px-[6px]">
            <span className="pl-[4px] text-meta text-text-quiet">No voiceover yet</span>
          </span>
        </div>

        <div className="flex items-center gap-[10px]">
          <LaneLabel>Music</LaneLabel>
          <span className="flex h-[30px] flex-1 items-center overflow-hidden rounded-badge bg-bg-inset px-[6px]">
            <span className="pl-[4px] text-meta text-text-quiet">No music yet</span>
          </span>
        </div>

        <Playhead />
      </div>

      <div className="flex items-center gap-[10px] border-t border-border-subtle p-[10px_14px]">
        <span className="flex-1 text-meta text-text-tertiary">
          Drag a boundary to hold a shot longer. Drag a shot to reorder it. Remove sends a shot to the bin, where Restore puts
          it back in its original position.
        </span>
        <span className="text-meta text-text-quiet">Retiming, reordering and removing are free and mark nothing stale.</span>
      </div>
    </div>
  )
}
