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
import { formatTimecode } from '@/lib/storyboard/timeline'
import { edgeAutoscroll } from './use-lane-drag'

export type PlayheadHandle = { startScrub: (e: ReactPointerEvent<HTMLElement>, jump: boolean) => void }

// The shared playhead (canvas 15b/15h). There is no playback yet: it moves only by dragging
// its handle or pressing on the ruler, and its position lives here, in client state alone.
// Scrubbing re-renders this component only - never the lane. While zoomed, a scrub held near
// the lane's edge scrolls it, exactly as a block drag does (edgeAutoscroll, once per frame).
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
  const [seconds, setSeconds] = useState(0)
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
      if (jump) setSeconds(timeAt(e.clientX))
      let pointerX = e.clientX
      // Each frame scrolls the lane if the pointer is at its edge, then re-reads the time
      // under the pointer - so a held pointer keeps advancing as the content slides under it.
      let frame = requestAnimationFrame(function tick() {
        edgeAutoscroll(scrollerRef.current, pointerX)
        setSeconds(timeAt(pointerX))
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
      }
      window.addEventListener('pointermove', move)
      window.addEventListener('pointerup', up)
      window.addEventListener('pointercancel', up)
      detach.current = up
    },
    [t, timeAt, width, scrollerRef]
  )

  useEffect(() => () => detach.current?.(), [])

  useImperativeHandle(ref, () => ({ startScrub }), [startScrub])

  const x = totalSeconds > 0 ? (t / totalSeconds) * width : 0
  const label = scrubFrom !== null && Math.abs(scrubFrom - t) > 0.05 ? `${formatTimecode(scrubFrom)} → ${formatTimecode(t)}` : formatTimecode(t)

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
