import { memo, useRef, useState } from 'react'
import { Spinner } from '@/components/spinner'
import type { DisplayElement } from './types'
import { useShots } from './shots-context'
import { useAssets } from './assets-context'
import { unbindElementFromShot } from '../actions'
import { ElementBindPicker } from './element-bind-picker'
import { ElementImage } from './element-image'

function RemoveIcon() {
  return (
    <svg width="7" height="7" viewBox="0 0 9 9" fill="none" aria-hidden="true">
      <path d="M1 1l7 7M8 1l-7 7" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  )
}

function PlusIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 13 13" fill="none" aria-hidden="true">
      <rect x="5.75" y="1" width="1.5" height="11" fill="currentColor" />
      <rect x="1" y="5.75" width="11" height="1.5" fill="currentColor" />
    </svg>
  )
}

function elementDotClassName(el: DisplayElement) {
  if (el.reference_image_path) return 'bg-status-done-fg'
  if (el.status === 'generating') return 'bg-status-active-fg'
  if (el.status === 'failed') return 'bg-status-failed-fg'
  return 'bg-border-strong' // pending / no reference - the only state reachable this task
}

// Canvas: "Bound element tiles" close-up. reference_image_path is checked first and wins
// regardless of status - a 'failed' status can still carry a path left over from an
// earlier successful generation (e.g. a failed regenerate attempt), and that saved image
// is exactly what should render, not a generic failure icon. status only decides the
// placeholder for the *no-path* case: generating (spinner), failed (error icon), or
// pending (initial letter). imageUrl is the signed URL for that path, looked up from
// AssetsProvider's already-loaded groups - the same signing/re-signing path the Assets
// tab uses, never a second one, and never persisted (ElementImage re-signs on error and
// keeps the result only in that context's in-memory state).
function ElementTile({ el, imageUrl }: { el: DisplayElement; imageUrl: string | null }) {
  if (el.reference_image_path) {
    return (
      <div className="h-[60px] w-[60px] flex-none overflow-hidden rounded-badge border border-border-subtle">
        <ElementImage path={el.reference_image_path} url={imageUrl} alt={el.name} />
      </div>
    )
  }

  if (el.status === 'generating') {
    return (
      <div className="flex h-[60px] w-[60px] flex-none animate-pulse items-center justify-center rounded-badge bg-skeleton-base">
        <Spinner className="h-4 w-4" thickness={1.5} />
      </div>
    )
  }

  if (el.status === 'failed') {
    return (
      <div className="flex h-[60px] w-[60px] flex-none items-center justify-center rounded-badge bg-status-failed-bg text-status-failed-fg">
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <circle cx="8" cy="8" r="6.5" stroke="currentColor" strokeWidth="1.3" />
          <path d="M8 4.6v4.2" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          <circle cx="8" cy="11.4" r="1" fill="currentColor" />
        </svg>
      </div>
    )
  }

  return (
    <div className="flex h-[60px] w-[60px] flex-none items-center justify-center rounded-badge border border-dashed border-border-muted bg-bg-well text-body text-text-quiet">
      {el.name.charAt(0).toUpperCase()}
    </div>
  )
}

export const BoundElements = memo(function BoundElements({
  shotId,
  elements,
  readOnly,
}: {
  shotId: string
  elements: DisplayElement[]
  readOnly: boolean
}) {
  const { updateShotLocal } = useShots()
  const { groups } = useAssets()
  const [pickerOpen, setPickerOpen] = useState(false)
  const [removingId, setRemovingId] = useState<string | null>(null)
  const [removeError, setRemoveError] = useState<string | null>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)

  async function handleRemove(el: DisplayElement) {
    setRemovingId(el.id)
    setRemoveError(null)
    const result = await unbindElementFromShot(shotId, el.id)
    setRemovingId(null)
    if (!result.success) {
      setRemoveError(result.error)
      return
    }
    updateShotLocal(shotId, { elements: elements.filter((e) => e.id !== el.id) })
  }

  function findImageUrl(elementId: string): string | null {
    for (const group of groups) {
      const found = group.elements.find((el) => el.id === elementId)
      if (found) return found.reference_image_url
    }
    return null
  }

  return (
    <div className="flex flex-col gap-rc-2xs">
      <span className="text-label font-medium uppercase leading-4 tracking-label text-text-tertiary">Bound elements</span>
      <div className="flex flex-wrap items-start gap-rc-sm">
        {elements.map((el) => (
          <div key={el.id} className="flex w-[60px] flex-col items-center gap-[5px]">
            <div className="group relative">
              <ElementTile el={el} imageUrl={findImageUrl(el.id)} />
              {!readOnly && (
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
              )}
            </div>
            <span className="flex max-w-full items-center gap-[5px] text-meta text-text-secondary">
              <span className={`h-[5px] w-[5px] flex-none rounded-full ${elementDotClassName(el)}`} aria-hidden />
              <span className="truncate">{el.name}</span>
            </span>
          </div>
        ))}
        {!readOnly && (
          <button
            ref={triggerRef}
            type="button"
            aria-label="Bind an element to this shot"
            onClick={() => setPickerOpen((open) => !open)}
            className="flex h-[60px] w-[60px] flex-none cursor-pointer items-center justify-center rounded-badge border border-dashed border-border-strong text-text-tertiary outline-none hover:border-accent hover:bg-accent-wash hover:text-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent active:border-accent-active active:bg-accent-wash-strong active:text-accent-active"
          >
            <PlusIcon />
          </button>
        )}
      </div>
      {removeError && <span className="text-meta text-status-failed-fg">{removeError}</span>}
      {pickerOpen && !readOnly && (
        <ElementBindPicker
          shotId={shotId}
          excludeIds={new Set(elements.map((el) => el.id))}
          anchorRef={triggerRef}
          onBind={(el) => updateShotLocal(shotId, { elements: [...elements, el] })}
          onClose={() => setPickerOpen(false)}
        />
      )}
    </div>
  )
})
