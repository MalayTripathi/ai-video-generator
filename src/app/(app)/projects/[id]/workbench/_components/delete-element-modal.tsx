'use client'

import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { BoundShot } from '@/lib/elements/write'
import { deleteElement } from '../actions'
import { useAssets } from './assets-context'

// Two-phase confirm, built on the same reusable shell as DeleteShotConfirmModal
// (canvas: "Anatomy - the reusable confirm"). Opens in `confirm`; deleteElementForUser's
// `reason: 'bound'` result flips it in place to `blocked` rather than closing and
// reopening a different modal - same dialog, same object, new information. There is no
// force/override anywhere in `blocked`: the prompt is explicit that dialogue and
// bindings are real work, and the only way out is to go unbind it first (canvas 12E,
// generalized past its dialogue-only framing - see the plan's canvas-vs-backend note:
// deleteElementForUser blocks on ANY shot_elements/shot_dialogue binding, not only
// dialogue).
export function DeleteElementModal({
  open,
  elementId,
  elementName,
  onClose,
}: {
  open: boolean
  elementId: string
  elementName: string
  onClose: () => void
}) {
  const { removeElementLocal } = useAssets()
  const [phase, setPhase] = useState<'confirm' | 'blocked'>('confirm')
  const [boundShots, setBoundShots] = useState<BoundShot[]>([])
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const confirmRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (!open) return
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setPhase('confirm')
    setBoundShots([])
    setPending(false)
    setError(null)
  }, [open, elementId])

  useEffect(() => {
    if (!open) return
    confirmRef.current?.focus()

    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [open, onClose, phase])

  if (!open) return null

  async function handleConfirmDelete() {
    setPending(true)
    setError(null)
    const result = await deleteElement(elementId)
    setPending(false)

    if (result.success) {
      removeElementLocal(elementId)
      onClose()
      return
    }

    if (result.reason === 'bound' && result.boundShots) {
      setBoundShots(result.boundShots)
      setPhase('blocked')
      return
    }

    setError(result.error)
  }

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-rc-md" onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="delete-element-modal-title"
        onClick={(e) => e.stopPropagation()}
        className="flex w-full max-w-[400px] flex-col gap-rc-sm rounded-frame border border-border-subtle bg-bg-surface p-rc-lg shadow-card-hover"
      >
        {phase === 'confirm' ? (
          <>
            <span id="delete-element-modal-title" className="text-section font-medium text-text-primary">
              Delete {elementName}?
            </span>
            <span className="text-small leading-[1.5] text-text-secondary">
              The element and its description go. Shots bound to it are not affected.
            </span>
            {error && <span className="text-small leading-[1.5] text-status-failed-fg">{error}</span>}
            <div className="mt-rc-2xs flex justify-end gap-rc-xs">
              <button
                type="button"
                onClick={onClose}
                disabled={pending}
                className="flex h-[34px] cursor-pointer items-center rounded-control border border-border-strong px-rc-sm text-small font-medium text-text-secondary outline-none hover:bg-bg-inset focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:cursor-not-allowed disabled:opacity-60"
              >
                Cancel
              </button>
              <button
                ref={confirmRef}
                type="button"
                onClick={handleConfirmDelete}
                disabled={pending}
                className="flex h-[34px] cursor-pointer items-center rounded-control border border-status-failed-fg px-rc-sm text-small font-medium text-status-failed-fg outline-none hover:bg-status-failed-bg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:cursor-not-allowed disabled:opacity-60"
              >
                {pending ? 'Deleting…' : 'Delete element'}
              </button>
            </div>
          </>
        ) : (
          <>
            <span id="delete-element-modal-title" className="text-section font-medium text-text-primary">
              {elementName} is used in {boundShots.length} shot{boundShots.length === 1 ? '' : 's'}
            </span>
            <span className="text-small leading-[1.5] text-text-secondary">
              Unbind it from the shots below first, then it can be deleted.
            </span>
            <div className="flex flex-col gap-[7px] rounded-control bg-bg-inset p-[10px_12px]">
              {boundShots.map((shot) => (
                <div key={shot.shot_id} className="flex items-baseline justify-between gap-rc-sm">
                  <span className="text-small text-text-secondary">
                    Shot {shot.shot_number} · {shot.label}
                  </span>
                </div>
              ))}
            </div>
            <div className="mt-rc-2xs flex justify-end gap-rc-xs">
              <button
                ref={confirmRef}
                type="button"
                onClick={onClose}
                className="flex h-[34px] cursor-pointer items-center rounded-control border border-accent px-rc-sm text-small font-medium text-accent outline-none hover:bg-accent-wash focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
              >
                Close
              </button>
            </div>
          </>
        )}
      </div>
    </div>,
    document.body
  )
}
