'use client'

import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react'
import { useRouter } from 'next/navigation'
import { createPortal } from 'react-dom'
import { SHOT_ELEMENT_TYPES } from '@/lib/config/enums'
import { ELEMENT_TYPE_SINGULAR_LABELS, identDotClassName } from '@/lib/element-type-labels'
import type { ProjectElement } from '@/lib/elements/read'
import type { DisplayElement } from './types'
import { useAssets } from './assets-context'
import { bindElementToShot } from '../actions'
import { ElementImage } from './element-image'

// ELEMENT_TYPE_SINGULAR_LABELS stores the raw enum value ('character', 'location',
// 'prop') - other call sites (element-group.tsx) use it lowercase mid-sentence ("Add
// character"), so the shared constant stays lowercase and this picker capitalises only
// at its own display layer, the same way element-group.tsx's placeholder text already
// does inline rather than through a second, capitalised constant.
function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1)
}

const PANEL_WIDTH = 300
// Header + the list's own max height + divider + footer button, for the flip-upward check.
const PANEL_MAX_HEIGHT = 340
const VIEWPORT_MARGIN = 12

type Position = { top?: number; bottom?: number; left: number }

// Portaled rather than a plain sibling-positioned popover (unlike CustomSelect/
// ChangeMenu): the expanded shot card's root element is overflow-hidden with
// content-driven height, and this row sits near the bottom of that content (just above
// the duration stepper / delete row) - a non-portaled popover here would get clipped far
// more often than CustomSelect's dropdowns, which sit higher in the card with more flow
// content still below them.
export function ElementBindPicker({
  shotId,
  excludeIds,
  anchorRef,
  onBind,
  onClose,
}: {
  shotId: string
  excludeIds: Set<string>
  anchorRef: RefObject<HTMLButtonElement | null>
  onBind: (element: DisplayElement) => void
  onClose: () => void
}) {
  const { groups, projectId } = useAssets()
  const router = useRouter()
  const panelRef = useRef<HTMLDivElement>(null)
  const [position, setPosition] = useState<Position | null>(null)
  const [pendingId, setPendingId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useLayoutEffect(() => {
    const rect = anchorRef.current?.getBoundingClientRect()
    if (!rect) return
    const spaceBelow = window.innerHeight - rect.bottom
    const openUpward = spaceBelow < PANEL_MAX_HEIGHT + 8 && rect.top > PANEL_MAX_HEIGHT + 8
    const left = Math.min(rect.left, window.innerWidth - PANEL_WIDTH - VIEWPORT_MARGIN)
    setPosition(
      openUpward
        ? { bottom: window.innerHeight - rect.top + 4, left }
        : { top: rect.bottom + 4, left }
    )
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    function handlePointerDown(event: PointerEvent) {
      const target = event.target as Node
      if (anchorRef.current?.contains(target)) return
      if (panelRef.current && !panelRef.current.contains(target)) onClose()
    }
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') onClose()
    }
    function handleScroll() {
      onClose()
    }
    document.addEventListener('pointerdown', handlePointerDown)
    document.addEventListener('keydown', handleKeyDown)
    document.addEventListener('scroll', handleScroll, true)
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown)
      document.removeEventListener('keydown', handleKeyDown)
      document.removeEventListener('scroll', handleScroll, true)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // SHOT_ELEMENT_TYPES (character, location, prop) rather than ELEMENT_TYPES is what
  // structurally excludes style - it's never even in the source array - and gives
  // "sorted by type in Assets order, no group headings" for free by flat-mapping each
  // type's elements in order. Soft-deleted elements are already absent from `groups`
  // (the query behind AssetsProvider filters deleted_at IS NULL).
  const pickable: ProjectElement[] = SHOT_ELEMENT_TYPES.flatMap((type) => {
    const group = groups.find((g) => g.type === type)
    return group ? group.elements.filter((el) => !excludeIds.has(el.id)) : []
  })

  async function handlePick(el: ProjectElement) {
    setPendingId(el.id)
    setError(null)
    const result = await bindElementToShot(shotId, el.id)
    setPendingId(null)
    if (!result.success) {
      setError(result.error)
      return
    }
    onBind(result.element)
  }

  function handleCreateNew() {
    onClose()
    router.push(`/projects/${projectId}/workbench?tab=assets`)
  }

  if (!position) return null

  return createPortal(
    <div
      ref={panelRef}
      role="menu"
      aria-label="Attach an element"
      className="fixed z-40 flex w-[300px] flex-col overflow-hidden rounded-frame border border-border-strong bg-bg-canvas shadow-card-hover"
      style={{ top: position.top, bottom: position.bottom, left: position.left }}
    >
      <span className="border-b border-border-subtle px-[14px] pb-2 pt-[11px] text-label uppercase tracking-label text-text-tertiary">
        Attach an element
      </span>
      <div className="flex flex-col p-[6px]">
        {pickable.length === 0 ? (
          <span className="px-2 py-2 text-meta text-text-tertiary">No elements available to bind yet.</span>
        ) : (
          <div className="flex max-h-[220px] flex-col overflow-y-auto">
            {pickable.map((el) => (
              <button
                key={el.id}
                type="button"
                role="menuitem"
                disabled={pendingId === el.id}
                onClick={() => handlePick(el)}
                className="flex w-full cursor-pointer items-center gap-[10px] rounded-control px-2 py-[7px] text-left outline-none hover:bg-bg-inset focus-visible:bg-bg-inset disabled:cursor-not-allowed disabled:opacity-60"
              >
                {el.reference_image_path ? (
                  <div className="h-[34px] w-[34px] flex-none overflow-hidden rounded-badge border border-border-subtle">
                    <ElementImage path={el.reference_image_path} url={el.reference_image_url} alt={el.name} />
                  </div>
                ) : (
                  <span className="flex h-[34px] w-[34px] flex-none items-center justify-center rounded-badge border border-dashed border-border-muted bg-bg-well text-control text-text-quiet">
                    {el.name.charAt(0).toUpperCase()}
                  </span>
                )}
                <span className="flex min-w-0 flex-1 flex-col gap-px">
                  <span className="truncate text-control text-text-primary">{el.name}</span>
                  <span className="flex items-center gap-[5px]">
                    <span
                      className={`h-[5px] w-[5px] flex-none rounded-full ${identDotClassName(el.type)}`}
                      aria-hidden
                    />
                    <span
                      className={`truncate text-meta ${el.reference_image_path ? 'text-text-tertiary' : 'text-text-quiet'}`}
                    >
                      {capitalize(ELEMENT_TYPE_SINGULAR_LABELS[el.type])}
                      {!el.reference_image_path && ' · No reference yet'}
                    </span>
                  </span>
                </span>
              </button>
            ))}
          </div>
        )}
        {error && <span className="px-2 pt-1 text-meta text-status-failed-fg">{error}</span>}
        <div className="mx-2 my-[6px] h-px bg-border-subtle" />
        {/* A button, not a link: this leaves the screen rather than picking a row, and as
            a link it read as a fourth item in the list above. Neutral, per canvas 14G - the
            accent stays with the step's primary action. */}
        <button
          type="button"
          onClick={handleCreateNew}
          className="m-[2px] flex h-[34px] cursor-pointer items-center justify-center rounded-control border border-border-strong bg-transparent text-control text-text-primary outline-none hover:border-border-strong-hover hover:bg-bg-inset focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
        >
          Upload or generate a new element
        </button>
      </div>
    </div>,
    document.body
  )
}
