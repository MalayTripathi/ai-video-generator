'use client'

import { useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { formatCost } from '@/lib/format-cost'
import type { ShotSpend } from '../actions'

// The reusable confirm pattern (canvas: "Anatomy - the reusable confirm") - title as a
// question naming its object, a body stating consequence not persuasion, an optional
// ledger strip, and a destructive action that stays at full strength regardless of
// spend. This is the first of several; later confirmations should copy this shape.
export function DeleteShotConfirmModal({
  open,
  shotNumber,
  elementsCount,
  spend,
  pending,
  error,
  onConfirm,
  onCancel,
}: {
  open: boolean
  shotNumber: number
  elementsCount: number
  spend: ShotSpend | null
  pending: boolean
  error?: string
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

  const bodyText =
    elementsCount > 0
      ? `Its voiceover, visual description and ${elementsCount} bound element${elementsCount === 1 ? '' : 's'} go with it. The shots after it renumber. The elements stay in your library.`
      : 'Its voiceover and visual description go with it. The shots after it renumber.'

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-rc-md" onClick={onCancel}>
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="delete-shot-modal-title"
        onClick={(e) => e.stopPropagation()}
        className="flex w-full max-w-[400px] flex-col gap-rc-sm rounded-frame border border-border-subtle bg-bg-surface p-rc-lg shadow-card-hover"
      >
        <span id="delete-shot-modal-title" className="text-section font-medium text-text-primary">
          Delete shot {shotNumber}?
        </span>
        <span className="text-small leading-[1.5] text-text-secondary">{bodyText}</span>
        {spend && spend.totalCost > 0 && (
          <div
            data-testid="delete-shot-ledger"
            className="flex flex-col gap-[7px] rounded-control bg-bg-inset px-3 py-[10px]"
          >
            <div className="flex items-baseline justify-between gap-rc-sm">
              <span className="text-small text-text-secondary">Spent on this shot</span>
              <span
                data-testid="delete-shot-amount"
                className="flex-none font-mono text-control font-medium text-text-primary"
              >
                {formatCost(spend.totalCost)}
              </span>
            </div>
            <div className="flex items-baseline justify-between gap-rc-sm">
              <span className="text-meta text-text-tertiary">{spend.operationLabels.join(', ')}</span>
              <span className="flex-none text-meta text-text-tertiary">not refunded</span>
            </div>
          </div>
        )}
        {error && <span className="text-small leading-[1.5] text-status-failed-fg">{error}</span>}
        <div className="mt-rc-2xs flex justify-end gap-rc-xs">
          <button
            type="button"
            onClick={onCancel}
            disabled={pending}
            className="flex h-[34px] cursor-pointer items-center rounded-control border border-border-strong px-rc-sm text-small font-medium text-text-secondary outline-none hover:bg-bg-inset focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:cursor-not-allowed disabled:opacity-60"
          >
            Cancel
          </button>
          <button
            ref={confirmRef}
            type="button"
            onClick={onConfirm}
            disabled={pending}
            className="flex h-[34px] cursor-pointer items-center rounded-control border border-status-failed-fg px-rc-sm text-small font-medium text-status-failed-fg outline-none hover:bg-status-failed-bg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:cursor-not-allowed disabled:opacity-60"
          >
            {pending ? 'Deleting…' : 'Delete shot'}
          </button>
        </div>
      </div>
    </div>,
    document.body
  )
}
