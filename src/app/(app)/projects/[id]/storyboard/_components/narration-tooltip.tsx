'use client'

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type PointerEvent } from 'react'
import { createPortal } from 'react-dom'

export type NarrationTip = { text: string; detail: string }

type Shown = NarrationTip & { key: string; rect: DOMRect }

// Gap between the block and the tooltip, and the least distance kept from the viewport edge.
const OFFSET_PX = 8
const EDGE_PX = 8

/**
 * The picture lane's hover tooltip: the whole narration of the block under the pointer, at
 * every width tier and in both modes. Keyed on the block, not its contents, so a block too
 * narrow to show any text still has one. Never shown while a button is held - a boundary,
 * reorder or split drag, or a scrub that started elsewhere - so it can't cover a drag.
 * Portalled with fixed positioning so the lane's overflow can't clip it.
 */
export function useNarrationTooltip(tipFor: (block: HTMLElement) => (NarrationTip & { key: string }) | null) {
  const [shown, setShown] = useState<Shown | null>(null)

  const hide = useCallback(() => setShown(null), [])

  // Any scroll moves the block out from under a fixed tooltip - drop it until the next move.
  const visible = shown !== null
  useEffect(() => {
    if (!visible) return
    window.addEventListener('scroll', hide, true)
    return () => window.removeEventListener('scroll', hide, true)
  }, [visible, hide])

  const track = useCallback(
    (e: PointerEvent<HTMLElement>) => {
      if (e.buttons !== 0) {
        setShown(null)
        return
      }
      const target = e.target as HTMLElement
      // Over a block only - a grip or a join chip carries its own tooltip.
      const block = target.closest<HTMLElement>('[data-testid="shot-block"]')
      const tip = block ? tipFor(target.closest<HTMLElement>('[data-testid="motion-segment"]') ?? block) : null
      if (!block || !tip) {
        setShown(null)
        return
      }
      setShown((prev) =>
        prev && prev.key === tip.key && prev.text === tip.text && prev.detail === tip.detail
          ? prev
          : { ...tip, rect: block.getBoundingClientRect() }
      )
    },
    [tipFor]
  )

  return { shown, track, hide }
}

export function NarrationTooltip({ shown }: { shown: Shown | null }) {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null)

  // Above the block, centred on it; below when there's no room above; kept on screen.
  useLayoutEffect(() => {
    const el = ref.current
    if (!shown || !el) {
      setPos(null)
      return
    }
    const { width, height } = el.getBoundingClientRect()
    const r = shown.rect
    const centre = r.left + r.width / 2
    const left = Math.min(Math.max(EDGE_PX, centre - width / 2), window.innerWidth - EDGE_PX - width)
    const above = r.top - OFFSET_PX - height
    const top = above >= EDGE_PX ? above : r.bottom + OFFSET_PX
    setPos({ left, top })
  }, [shown])

  if (!shown || typeof document === 'undefined') return null
  return createPortal(
    <div
      ref={ref}
      role="tooltip"
      data-testid="narration-tooltip"
      data-shot-key={shown.key}
      style={pos ? { left: pos.left, top: pos.top } : { left: 0, top: 0, visibility: 'hidden' }}
      className="pointer-events-none fixed z-50 flex max-w-[320px] flex-col gap-[2px] rounded-badge bg-text-primary px-[8px] py-[5px] text-bg-canvas shadow-card"
    >
      <span data-testid="narration-tooltip-text" className="whitespace-normal text-small leading-[1.45]">
        {shown.text}
      </span>
      {shown.detail && <span className="font-mono text-mono opacity-70">{shown.detail}</span>}
    </div>,
    document.body
  )
}
