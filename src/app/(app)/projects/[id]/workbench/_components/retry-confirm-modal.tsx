'use client'

import { useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'

export function RetryConfirmModal({
  open,
  hasPendingPayload,
  estimatedCredits,
  replacesExisting,
  onConfirm,
  onCancel,
}: {
  open: boolean
  hasPendingPayload: boolean
  estimatedCredits: number
  replacesExisting: boolean
  onConfirm: () => void
  onCancel: () => void
}) {
  const confirmRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (!open) return
    confirmRef.current?.focus()

    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') onCancel()
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [open, onCancel])

  if (!open) return null

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-rc-md"
      onClick={onCancel}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="retry-confirm-title"
        onClick={(e) => e.stopPropagation()}
        className="flex w-full max-w-[400px] flex-col gap-rc-sm rounded-frame border border-border-subtle bg-bg-surface p-rc-lg shadow-card-hover"
      >
        <span id="retry-confirm-title" className="text-section font-medium text-text-primary">
          Generate the shot list again?
        </span>
        <span className="text-small leading-[1.5] text-text-secondary">
          {hasPendingPayload
            ? 'Your last generation already finished and is saved. Resuming just writes it to your project — no additional credits.'
            : `This starts a new shot generation and uses approximately ${estimatedCredits} credits.`}
        </span>
        {replacesExisting && (
          <span className="text-small leading-[1.5] text-status-failed-fg">
            The shots currently listed will be replaced, not added to.
          </span>
        )}
        <div className="mt-rc-2xs flex justify-end gap-rc-xs">
          <button
            type="button"
            onClick={onCancel}
            className="flex h-9 cursor-pointer items-center rounded-control px-rc-sm text-small font-medium text-text-secondary outline-none hover:bg-bg-inset focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
          >
            Cancel
          </button>
          <button
            ref={confirmRef}
            type="button"
            onClick={onConfirm}
            className="flex h-9 cursor-pointer items-center rounded-control border border-accent bg-accent px-rc-sm text-small font-medium text-white outline-none hover:bg-accent-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent active:bg-accent-active"
          >
            {hasPendingPayload ? 'Resume' : 'Generate'}
          </button>
        </div>
      </div>
    </div>,
    document.body
  )
}
