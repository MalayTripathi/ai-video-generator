'use client'

import {
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type Ref,
  type RefObject,
} from 'react'
import { formatPlayTime } from '@/lib/storyboard/timeline'
import { edgeAutoscroll } from './use-lane-drag'
import { usePlayback, usePlaybackEngine } from './playback-context'

export type PlayheadHandle = { startScrub: (e: ReactPointerEvent<HTMLElement>, jump: boolean) => void }

// The shared playhead (canvas 15b/15h). One clock with the Preview player (playback-
// context): dragging the handle or pressing on the ruler seeks, and during playback it
// follows, scrolling a zoomed lane with the same edge auto-scroll a block drag uses.
// Scrubbing moves the time only, never a duration or the order of shots.
export function Playhead({
  ref,
  totalSeconds,
  contentWidth,
  scrollerRef,
}: {
  ref: Ref<PlayheadHandle>
  totalSeconds: number
  contentWidth: number | null
  scrollerRef: RefObject<HTMLDivElement | null>
}) {
  const engine = usePlaybackEngine()
  const { t: seconds, playing, scrubbing } = usePlayback()
  const [scrubFrom, setScrubFrom] = useState<number | null>(null)
  const self = useRef<HTMLSpanElement>(null)
  const detach = useRef<(() => void) | null>(null)
  const t = Math.min(seconds, totalSeconds)
  const width = contentWidth ?? 0

  const timeAt = useCallback(
    (clientX: number) => {
      const origin = self.current?.parentElement?.getBoundingClientRect().left ?? 0
      if (width <= 0 || totalSeconds <= 0) return 0
      return Math.max(0, Math.min(totalSeconds, ((clientX - origin) / width) * totalSeconds))
    },
    [width, totalSeconds]
  )

  const startScrub = useCallback(
    (e: ReactPointerEvent<HTMLElement>, jump: boolean) => {
      if (e.button !== 0 || width <= 0) return
      e.preventDefault()
      e.stopPropagation()
      detach.current?.()
      setScrubFrom(t)
      engine.beginScrub()
      if (jump) engine.seek(timeAt(e.clientX))
      let pointerX = e.clientX
      // Each frame scrolls the lane if the pointer is at its edge, then re-reads the time
      // under the pointer - so a held pointer keeps advancing as the content slides under it.
      let frame = requestAnimationFrame(function tick() {
        edgeAutoscroll(scrollerRef.current, pointerX)
        engine.seek(timeAt(pointerX))
        frame = requestAnimationFrame(tick)
      })
      const move = (ev: PointerEvent) => {
        pointerX = ev.clientX
      }
      const up = () => {
        cancelAnimationFrame(frame)
        window.removeEventListener('pointermove', move)
        window.removeEventListener('pointerup', up)
        window.removeEventListener('pointercancel', up)
        detach.current = null
        setScrubFrom(null)
        engine.endScrub()
      }
      window.addEventListener('pointermove', move)
      window.addEventListener('pointerup', up)
      window.addEventListener('pointercancel', up)
      detach.current = up
    },
    [t, timeAt, width, scrollerRef, engine]
  )

  useEffect(() => () => detach.current?.(), [])

  useImperativeHandle(ref, () => ({ startScrub }), [startScrub])

  const x = totalSeconds > 0 ? (t / totalSeconds) * width : 0

  // Follow during playback: keep the playhead inside a zoomed lane.
  useEffect(() => {
    if (!playing || scrubbing) return
    const origin = self.current?.parentElement?.getBoundingClientRect().left
    if (origin !== undefined) edgeAutoscroll(scrollerRef.current, origin + x)
  }, [playing, scrubbing, x, scrollerRef])

  const label =
    scrubFrom !== null && Math.abs(scrubFrom - t) > 0.05 ? `${formatPlayTime(scrubFrom)} → ${formatPlayTime(t)}` : formatPlayTime(t)

  return (
    <span
      ref={self}
      data-testid="playhead"
      data-seconds={t.toFixed(2)}
      className="pointer-events-none absolute bottom-0 top-[25px] z-[15] block w-px bg-text-primary"
      style={{ left: x }}
    >
      <span
        data-testid="playhead-handle"
        title="Drag to scrub"
        onPointerDown={(e) => startScrub(e, false)}
        className="pointer-events-auto absolute left-[-5px] top-[-5px] block h-[11px] w-[11px] cursor-ew-resize touch-none rounded-[2px] bg-text-primary"
      />
      {scrubFrom !== null && (
        <span className="absolute left-[8px] top-[-24px] whitespace-nowrap rounded-badge bg-text-primary px-[6px] py-[2px] font-mono text-mono text-bg-canvas">
          {label}
        </span>
      )}
    </span>
  )
}
