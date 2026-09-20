'use client'

import { useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { InsufficientCreditsBanner } from '@/components/insufficient-credits-banner'

// The one confirmation dialog for a footer button that advances the project to the next
// step: the Workbench's "Generate image prompts" and Step 3's "Continue to storyboard".
// Copy is the caller's; the insufficient-balance state (Confirm disabled, Cancel enabled)
// is shared - a second copy would drift, same as InsufficientCreditsBanner.
export function AdvanceConfirmModal({
  open,
  phase,
  submitting,
  title,
  body,
  bannerTitle,
  confirmLabel,
  requiredCredits,
  balanceCredits,
  onConfirm,
  onCancel,
}: {
  open: boolean
  phase: 'confirm' | 'insufficient'
  submitting: boolean
  title: string
  body: string
  bannerTitle: string
  confirmLabel: string
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

  const confirmDisabled = phase === 'insufficient' || submitting

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-rc-md"
      onClick={onCancel}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="advance-confirm-title"
        onClick={(e) => e.stopPropagation()}
        className="flex w-full max-w-[400px] flex-col gap-rc-sm rounded-frame border border-border-subtle bg-bg-surface p-rc-lg shadow-card-hover"
      >
        <span id="advance-confirm-title" className="text-section font-medium text-text-primary">
          {title}
        </span>

        <span className="text-small leading-[1.5] text-text-secondary">{body}</span>

        {phase === 'insufficient' && (
          <InsufficientCreditsBanner
            title={bannerTitle}
            requiredCredits={requiredCredits}
            balanceCredits={balanceCredits}
          />
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
            disabled={confirmDisabled}
            aria-busy={submitting}
            className="flex h-9 cursor-pointer items-center rounded-control border border-accent bg-accent px-rc-sm text-small font-medium text-white outline-none hover:bg-accent-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent active:bg-accent-active disabled:cursor-not-allowed disabled:opacity-60"
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>,
    document.body
  )
}
