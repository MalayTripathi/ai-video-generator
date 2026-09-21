'use client'

import { memo, useRef, useState } from 'react'
import { identDotClassName } from '@/lib/element-type-labels'
import type { DisplayElement } from '../../workbench/_components/types'
import { useAssets } from '../../workbench/_components/assets-context'
import { ElementBindPicker } from '../../workbench/_components/element-bind-picker'
import { ElementTile } from '../../workbench/_components/bound-elements'
import { unbindElementFromShot } from '../../workbench/actions'
import { useImagePrompts } from './image-prompts-context'

function RemoveIcon() {
  return (
    <svg width="7" height="7" viewBox="0 0 9 9" fill="none" aria-hidden="true">
      <path d="M1 1l7 7M8 1l-7 7" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  )
}

function PlusIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 13 13" fill="none" aria-hidden="true">
      <rect x="5.85" y="1" width="1.3" height="11" fill="currentColor" />
      <rect x="1" y="5.85" width="11" height="1.3" fill="currentColor" />
    </svg>
  )
}

// The references bound to this frame. Binding and unbinding are the Workbench's own
// actions (they flag the shot's prompt stale server-side, mirrored here locally) and the
// picker is the Workbench's own component - one pattern, carried forward.
export const PromptReferences = memo(function PromptReferences({
  shotId,
  elements,
}: {
  shotId: string
  elements: DisplayElement[]
}) {
  const { updateShotLocal } = useImagePrompts()
  const { groups } = useAssets()
  const [pickerOpen, setPickerOpen] = useState(false)
  const [removingId, setRemovingId] = useState<string | null>(null)
  const [removeError, setRemoveError] = useState<string | null>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)

  async function handleRemove(el: DisplayElement) {
    setRemovingId(el.id)
    setRemoveError(null)
    const result = await unbindElementFromShot(shotId, el.id, 'image_prompts')
    setRemovingId(null)
    if (!result.success) {
      setRemoveError(result.error)
      return
    }
    updateShotLocal(shotId, { elements: elements.filter((e) => e.id !== el.id), image_prompt_stale: true })
  }

  function findImageUrl(elementId: string): string | null {
    for (const group of groups) {
      const found = group.elements.find((el) => el.id === elementId)
      if (found) return found.reference_image_url
    }
    return null
  }

  return (
    <div className="flex flex-col gap-[7px]">
      <span className="text-label font-medium uppercase leading-4 tracking-label text-text-tertiary">
        References attached to this frame
      </span>
      <div className="flex flex-wrap items-start gap-rc-xs">
        {elements.map((el) => (
          <div key={el.id} className="flex w-[60px] flex-col gap-[5px]">
            <div className="group relative">
              <ElementTile el={el} imageUrl={findImageUrl(el.id)} />
              <button
                type="button"
                aria-label={`Remove ${el.name}`}
                title={`Remove ${el.name}`}
                onClick={() => handleRemove(el)}
                disabled={removingId === el.id}
                className="absolute -right-1 -top-1 flex h-4 w-4 cursor-pointer items-center justify-center rounded-full border border-bg-surface bg-status-failed-bg text-status-failed-fg opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100 disabled:cursor-not-allowed disabled:opacity-100"
              >
                <RemoveIcon />
              </button>
            </div>
            <span className="flex max-w-full items-center gap-[4px] text-meta text-text-secondary">
              <span
                className={`h-[5px] w-[5px] flex-none rounded-full ${identDotClassName(el.type)}`}
                aria-hidden
              />
              <span className="truncate">{el.name}</span>
            </span>
          </div>
        ))}
        <button
          ref={triggerRef}
          type="button"
          aria-label="Attach an element to this frame"
          onClick={() => setPickerOpen((open) => !open)}
          className="flex h-[60px] w-[60px] flex-none cursor-pointer items-center justify-center rounded-badge border border-dashed border-border-strong text-text-tertiary outline-none hover:border-accent hover:bg-accent-wash hover:text-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent active:border-accent-active active:bg-accent-wash-strong active:text-accent-active"
        >
          <PlusIcon />
        </button>
      </div>
      {removeError && <span className="text-meta text-status-failed-fg">{removeError}</span>}
      {pickerOpen && (
        <ElementBindPicker
          shotId={shotId}
          surface="image_prompts"
          excludeIds={new Set(elements.map((e) => e.id))}
          anchorRef={triggerRef}
          onBind={(element) => {
            updateShotLocal(shotId, { elements: [...elements, element], image_prompt_stale: true })
          }}
          onClose={() => setPickerOpen(false)}
        />
      )}
    </div>
  )
})
