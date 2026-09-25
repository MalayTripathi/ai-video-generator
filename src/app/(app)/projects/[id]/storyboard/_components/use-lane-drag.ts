'use client'

import { useCallback, useEffect, useRef, type PointerEvent as ReactPointerEvent, type RefObject } from 'react'
import { flushSync } from 'react-dom'
import { DRAG_THRESHOLD_PX, LANE_AUTOSCROLL_EDGE_PX, LANE_AUTOSCROLL_MAX_PX } from '@/lib/config/storyboard'
import {
  filmDuration,
  formatTimecode,
  LANE_GUTTER_PX,
  retimeBounds,
  snapRetime,
  type LaneLayout,
  type RetimeBounds,
} from '@/lib/storyboard/timeline'
import type { StoryboardShot } from './types'

// What the drag reads at pointer-down. Held in a ref so the handlers stay stable while the
// lane re-renders.
export type LaneDragInputs = {
  layout: LaneLayout | null
  laneShots: StoryboardShot[]
  totalSeconds: number
  retimeMaxSec: number | null
  readOnly: boolean
  retime: (shotId: string, seconds: number) => void
  reorder: (shotId: string, toLaneIndex: number) => void
}

type RetimeDrag = {
  kind: 'retime'
  shotId: string
  slot: HTMLElement
  startWidthStyle: string
  slotLeft: number
  startBlockPx: number
  gutter: number
  startX: number
  pxPerSecond: number
  bounds: RetimeBounds
  committed: number
  seconds: number
}

type MoveDrag = {
  kind: 'move'
  shotId: string
  from: number
  slots: HTMLElement[]
  lefts: number[]
  widths: number[]
  startClientX: number
  startX: number
  target: number
  active: boolean
  pointerId: number
}

type Drag = RetimeDrag | MoveDrag

// One animation frame of edge auto-scroll for any drag across the zoomed lane (a block, a
// boundary, the playhead): within LANE_AUTOSCROLL_EDGE_PX of an edge the lane scrolls,
// faster the nearer the pointer is, up to LANE_AUTOSCROLL_MAX_PX per frame.
export function edgeAutoscroll(scroller: HTMLElement | null, clientX: number) {
  if (!scroller || scroller.scrollWidth <= scroller.clientWidth) return
  const rect = scroller.getBoundingClientRect()
  let v = 0
  if (clientX < rect.left + LANE_AUTOSCROLL_EDGE_PX) v = -(rect.left + LANE_AUTOSCROLL_EDGE_PX - clientX) / LANE_AUTOSCROLL_EDGE_PX
  else if (clientX > rect.right - LANE_AUTOSCROLL_EDGE_PX) v = (clientX - (rect.right - LANE_AUTOSCROLL_EDGE_PX)) / LANE_AUTOSCROLL_EDGE_PX
  if (v !== 0) scroller.scrollLeft += Math.max(-1, Math.min(1, v)) * LANE_AUTOSCROLL_MAX_PX
}

function formatLength(seconds: number): string {
  return `${seconds.toFixed(1)}s`
}

// The picture lane's two drags - a boundary (retime) and a shot (reorder) - on native
// pointer events. Every pointer move only records the pointer; one animation frame per
// display frame writes widths and transforms straight onto the DOM, so the lane never
// re-renders mid-drag and nothing reaches the server until the drop. Esc cancels. A press
// that never travels DRAG_THRESHOLD_PX is a click, and selects the shot as usual.
export function useLaneDrag({
  inputs,
  scrollerRef,
  tooltipRef,
  totalRef,
  pendingRef,
}: {
  inputs: LaneDragInputs
  scrollerRef: RefObject<HTMLDivElement | null>
  tooltipRef: RefObject<HTMLSpanElement | null>
  totalRef: RefObject<HTMLSpanElement | null>
  pendingRef: RefObject<HTMLSpanElement | null>
}) {
  const latest = useRef(inputs)
  useEffect(() => {
    latest.current = inputs
  })

  const drag = useRef<Drag | null>(null)
  const pointerX = useRef(0)
  const frame = useRef<number | null>(null)
  const suppressClick = useRef(false)
  const detach = useRef<(() => void) | null>(null)

  const contentX = useCallback(
    (clientX: number) => {
      const scroller = scrollerRef.current
      if (!scroller) return clientX
      return clientX - scroller.getBoundingClientRect().left + scroller.scrollLeft
    },
    [scrollerRef]
  )

  const showPending = useCallback(
    (text: string | null) => {
      const total = totalRef.current
      const pending = pendingRef.current
      if (!total || !pending) return
      total.hidden = text !== null
      pending.hidden = text === null
      const label = pending.querySelector<HTMLElement>('[data-pending-total]')
      if (label && text !== null) label.textContent = text
    },
    [totalRef, pendingRef]
  )

  const autoscroll = useCallback(() => edgeAutoscroll(scrollerRef.current, pointerX.current), [scrollerRef])

  // The frame loop re-schedules itself through a ref, so each frame runs the latest tick.
  const tickRef = useRef<() => void>(() => {})
  const schedule = useCallback(() => {
    frame.current = requestAnimationFrame(() => tickRef.current())
  }, [])

  const tick = useCallback(() => {
    const d = drag.current
    if (!d) return
    if (d.kind === 'retime') {
      autoscroll()
      const px = d.startBlockPx + (contentX(pointerX.current) - d.startX)
      const seconds = snapRetime(px / d.pxPerSecond, d.bounds)
      d.seconds = seconds
      const blockPx = seconds * d.pxPerSecond
      d.slot.style.width = `${blockPx + d.gutter}px`
      const tip = tooltipRef.current
      if (tip) {
        tip.hidden = false
        tip.textContent = `${formatLength(d.committed)} → ${formatLength(seconds)}`
        tip.style.left = `${d.slotLeft + blockPx + d.gutter / 2}px`
      }
      showPending(formatTimecode(latest.current.totalSeconds - d.committed + seconds))
    } else {
      if (!d.active) {
        if (Math.abs(pointerX.current - d.startClientX) < DRAG_THRESHOLD_PX) {
          schedule()
          return
        }
        d.active = true
        const lifted = d.slots[d.from]
        lifted.style.zIndex = '10'
        lifted.style.opacity = '0.85'
        lifted.dataset.dragging = 'true'
        // Captured only once it is a drag: capturing at pointer-down would retarget the
        // click that a plain press must still deliver to the block.
        if (lifted.isConnected) lifted.setPointerCapture?.(d.pointerId)
      }
      autoscroll()
      const dx = contentX(pointerX.current) - d.startX
      d.slots[d.from].style.transform = `translateX(${dx}px)`
      const center = d.lefts[d.from] + d.widths[d.from] / 2 + dx
      let target = 0
      d.slots.forEach((_, j) => {
        if (j !== d.from && d.lefts[j] + d.widths[j] / 2 < center) target++
      })
      d.target = target
      const last = d.from === d.slots.length - 1
      const shift = d.widths[d.from] + (last ? LANE_GUTTER_PX : 0)
      d.slots.forEach((slot, j) => {
        if (j === d.from) return
        const offset =
          d.from < target && j > d.from && j <= target ? -shift : d.from > target && j >= target && j < d.from ? shift : 0
        slot.style.transform = offset ? `translateX(${offset}px)` : ''
      })
    }
    schedule()
  }, [autoscroll, contentX, schedule, showPending, tooltipRef])

  useEffect(() => {
    tickRef.current = tick
  }, [tick])

  const end = useCallback(
    (commit: boolean) => {
      const d = drag.current
      drag.current = null
      if (frame.current !== null) cancelAnimationFrame(frame.current)
      frame.current = null
      detach.current?.()
      detach.current = null
      if (!d) return
      if (d.kind === 'retime') {
        // Hand the width back to React before it re-renders, so a no-op or a refused edit
        // never leaves a stale inline width behind.
        d.slot.style.width = d.startWidthStyle
        if (tooltipRef.current) tooltipRef.current.hidden = true
        showPending(null)
        if (commit && d.seconds !== d.committed) flushSync(() => latest.current.retime(d.shotId, d.seconds))
        return
      }
      if (!d.active) return
      if (commit && d.target !== d.from) flushSync(() => latest.current.reorder(d.shotId, d.target))
      d.slots.forEach((slot) => {
        slot.style.transform = ''
        slot.style.zIndex = ''
        slot.style.opacity = ''
        delete slot.dataset.dragging
      })
      // The click that follows a real drag's pointerup must not select the shot.
      suppressClick.current = true
      setTimeout(() => {
        suppressClick.current = false
      }, 0)
    },
    [showPending, tooltipRef]
  )

  useEffect(() => () => end(false), [end])

  const attach = useCallback(() => {
    const move = (e: PointerEvent) => {
      pointerX.current = e.clientX
    }
    const up = () => end(true)
    const cancel = () => end(false)
    const key = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      e.stopPropagation()
      end(false)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', cancel)
    window.addEventListener('keydown', key, true)
    detach.current = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointercancel', cancel)
      window.removeEventListener('keydown', key, true)
    }
    schedule()
  }, [end, schedule])

  const onPointerDown = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      const inp = latest.current
      if (e.button !== 0 || inp.readOnly || drag.current || !inp.layout) return
      const target = e.target as HTMLElement
      const lane = e.currentTarget
      const slots = Array.from(lane.querySelectorAll<HTMLElement>('[data-testid="shot-slot"]'))
      const x = contentX(e.clientX)
      pointerX.current = e.clientX

      const grip = target.closest<HTMLElement>('[data-grip]')
      if (grip) {
        const index = slots.findIndex((s) => s.dataset.shotId === grip.dataset.shotId)
        const shot = inp.laneShots[index]
        const bounds = shot ? retimeBounds(inp.retimeMaxSec, filmDuration(shot)) : null
        if (!shot || !bounds || inp.layout.pxPerSecond <= 0) return
        e.preventDefault()
        grip.focus()
        grip.setPointerCapture?.(e.pointerId)
        const slot = slots[index]
        const scroller = scrollerRef.current!
        drag.current = {
          kind: 'retime',
          shotId: shot.id,
          slot,
          startWidthStyle: slot.style.width,
          slotLeft: slot.getBoundingClientRect().left - scroller.getBoundingClientRect().left + scroller.scrollLeft,
          startBlockPx: inp.layout.blocks[index],
          gutter: index === slots.length - 1 ? 0 : LANE_GUTTER_PX,
          startX: x,
          pxPerSecond: inp.layout.pxPerSecond,
          bounds,
          committed: filmDuration(shot) ?? 0,
          seconds: filmDuration(shot) ?? 0,
        }
        attach()
        return
      }

      const slot = target.closest<HTMLElement>('[data-testid="shot-slot"]')
      if (!slot || target.closest('button')) return
      const from = slots.indexOf(slot)
      if (from < 0 || slots.length < 2) return
      const scroller = scrollerRef.current!
      const origin = scroller.getBoundingClientRect().left - scroller.scrollLeft
      const rects = slots.map((s) => s.getBoundingClientRect())
      drag.current = {
        kind: 'move',
        shotId: inp.laneShots[from].id,
        from,
        slots,
        lefts: rects.map((r) => r.left - origin),
        widths: rects.map((r) => r.width),
        startClientX: e.clientX,
        startX: x,
        target: from,
        active: false,
        pointerId: e.pointerId,
      }
      attach()
    },
    [attach, contentX, scrollerRef]
  )

  // For the block's click handler: true exactly once, right after a real drag.
  const consumeClick = useCallback(() => suppressClick.current, [])

  return { onPointerDown, consumeClick }
}
