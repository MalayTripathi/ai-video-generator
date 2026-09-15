'use client'

import { useEffect, useRef } from 'react'

// Small action menu opened from a reference-set card's "Edit" control (originally
// "Change" on canvas "4. Change" - the trigger label was renamed, this component
// wasn't). Not CustomSelect - that's a single-select-with-checkmark widget for a
// persistent value; this is a one-shot action list with no selection state, so it gets
// its own component, reusing only the escape/click-outside mechanics.
export function ChangeMenu({
  onUpload,
  onGenerate,
  onRemove,
  generateCredits,
  generateDisabled,
  onClose,
}: {
  onUpload: () => void
  onGenerate: () => void
  onRemove: () => void
  generateCredits: number
  generateDisabled: boolean
  onClose: () => void
}) {
  const menuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose()
    }
    function handleClickOutside(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) onClose()
    }
    document.addEventListener('keydown', handleKeyDown)
    document.addEventListener('mousedown', handleClickOutside)
    return () => {
      document.removeEventListener('keydown', handleKeyDown)
      document.removeEventListener('mousedown', handleClickOutside)
    }
  }, [onClose])

  return (
    <div
      ref={menuRef}
      role="menu"
      className="absolute right-0 top-full z-10 mt-[4px] flex w-[168px] flex-col overflow-hidden rounded-control border border-border-subtle bg-bg-surface py-[4px] shadow-card-hover"
    >
      <button
        type="button"
        role="menuitem"
        onClick={() => {
          onUpload()
          onClose()
        }}
        className="flex h-8 cursor-pointer items-center px-rc-sm text-left text-small text-text-primary hover:bg-bg-inset"
      >
        Upload
      </button>
      <button
        type="button"
        role="menuitem"
        disabled={generateDisabled}
        onClick={() => {
          onGenerate()
          onClose()
        }}
        className="flex h-8 cursor-pointer items-center justify-between px-rc-sm text-left text-small text-text-primary hover:bg-bg-inset disabled:cursor-not-allowed disabled:text-text-quiet disabled:hover:bg-transparent"
      >
        {/* This menu only ever opens from a card that already has a reference (see
            ElementCard) - "Generate" would read as a first generation when it's really
            a replacement that discards the current image and charges again. */}
        Regenerate
        <span className="font-mono text-mono text-text-tertiary">{generateCredits} cr</span>
      </button>
      <button
        type="button"
        role="menuitem"
        onClick={() => {
          onRemove()
          onClose()
        }}
        className="flex h-8 cursor-pointer items-center px-rc-sm text-left text-small text-status-failed-fg hover:bg-status-failed-bg"
      >
        Remove
      </button>
    </div>
  )
}
