'use client'

import { useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'

export function ImagePromptsConfirmModal({
  open,
  phase,
  submitting,
  requiredCredits,
  balanceCredits,
  onConfirm,
  onCancel,
}: {
  open: boolean
  phase: 'confirm' | 'insufficient'
  submitting: boolean
  requiredCredits: number
  balanceCredits: number | null
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

  const generateDisabled = phase === 'insufficient' || submitting

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-rc-md"
      onClick={onCancel}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="image-prompts-confirm-title"
        onClick={(e) => e.stopPropagation()}
        className="flex w-full max-w-[400px] flex-col gap-rc-sm rounded-frame border border-border-subtle bg-bg-surface p-rc-lg shadow-card-hover"
      >
        <span id="image-prompts-confirm-title" className="text-section font-medium text-text-primary">
          Generate image prompts?
        </span>

        <span className="text-small leading-[1.5] text-text-secondary">
          This starts writing image prompts for every shot and uses {requiredCredits} credits.
        </span>

        {phase === 'insufficient' && (
          <div className="flex items-start gap-rc-sm rounded-control border-l-2 border-status-active-fg bg-status-active-bg p-[14px_16px]">
            <div className="flex flex-1 flex-col gap-[3px]">
              <span className="text-control font-medium text-banner-active-title">
                Not enough credits for image prompts
              </span>
              <span className="text-small leading-[1.5] text-banner-active-body">
                This step needs {requiredCredits} credits. You have {balanceCredits ?? 0} credits available.
              </span>
            </div>
            <button
              type="button"
              disabled
              className="flex h-8 flex-none cursor-not-allowed items-center rounded-control border border-accent bg-bg-surface px-rc-sm text-small font-medium text-accent opacity-60 hover:bg-status-active-bg-hover"
            >
              Add credits
            </button>
          </div>
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
            disabled={generateDisabled}
            aria-busy={submitting}
            className="flex h-9 cursor-pointer items-center rounded-control border border-accent bg-accent px-rc-sm text-small font-medium text-white outline-none hover:bg-accent-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent active:bg-accent-active disabled:cursor-not-allowed disabled:opacity-60"
          >
            Generate
          </button>
        </div>
      </div>
    </div>,
    document.body
  )
}
