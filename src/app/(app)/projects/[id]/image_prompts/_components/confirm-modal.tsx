'use client'

import { useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { formatCredits } from '@/lib/format-credits'
import { useImagePrompts } from './image-prompts-context'
import { isEdited } from './derive-image-prompts-phase'

const QUOTE_MAX_CHARS = 140

function clamp(text: string) {
  return text.length > QUOTE_MAX_CHARS ? `${text.slice(0, QUOTE_MAX_CHARS).trimEnd()}…` : text
}

// Overwrite confirmation (canvas 14F) and the Regenerate All confirmation share one
// chrome. The dialog protects handwriting and prices the action; an unedited single
// regeneration never reaches it.
export function ConfirmModal() {
  const { modal, shots, costFor, confirmModal, cancelModal } = useImagePrompts()
  const confirmRef = useRef<HTMLButtonElement>(null)
  const open = modal !== null

  useEffect(() => {
    if (!open) return
    confirmRef.current?.focus()
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') cancelModal()
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [open, cancelModal])

  if (!modal) return null

  let title: string
  let body: string
  let quote: string | null = null
  let credits: number
  let confirmLabel: string

  if (modal.kind === 'overwrite') {
    const shot = shots.find((s) => s.id === modal.shotId)
    if (!shot) return null
    title = `Regenerate Shot ${shot.order_index + 1}?`
    body =
      'You edited this prompt by hand. Regenerating writes a new one from the current shot and your edit will be overwritten.'
    quote = clamp(shot.image_prompt ?? '')
    credits = costFor(1)
    confirmLabel = 'Regenerate'
  } else {
    const editedCount = shots.filter(isEdited).length
    title = 'Regenerate all prompts?'
    body =
      editedCount > 0
        ? `This rewrites every shot's prompt, including ones already up to date. ${editedCount === 1 ? '1 prompt you edited' : `${editedCount} prompts you edited`} by hand will be overwritten.`
        : "This rewrites every shot's prompt, including ones already up to date."
    credits = costFor(shots.length)
    confirmLabel = 'Regenerate all'
  }

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-rc-md"
      onClick={cancelModal}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="prompt-confirm-title"
        onClick={(e) => e.stopPropagation()}
        className="flex w-full max-w-[460px] flex-col gap-[14px] rounded-frame border border-border-strong bg-bg-canvas p-[24px_26px] shadow-card-hover"
      >
        <div className="flex flex-col gap-[7px]">
          <span id="prompt-confirm-title" className="text-section font-medium tracking-micro text-text-primary">
            {title}
          </span>
          <span className="text-small leading-[1.55] text-text-secondary">{body}</span>
        </div>

        {quote !== null && (
          <div className="flex flex-col gap-[3px] rounded-control border-l-2 border-status-edited-fg bg-status-edited-bg p-[10px_12px]">
            <span className="text-label uppercase tracking-label text-status-edited-fg">Your version</span>
            <span className="text-small leading-[1.45] text-text-secondary">{quote}</span>
          </div>
        )}

        <div className="flex items-center justify-between gap-rc-md pt-[2px]">
          <span className="font-mono text-mono text-text-tertiary">
            {formatCredits(credits)} {credits === 1 ? 'credit' : 'credits'}
          </span>
          <div className="flex gap-[10px]">
            <button
              type="button"
              onClick={cancelModal}
              className="flex h-9 cursor-pointer items-center rounded-control border border-border-strong px-rc-md text-control text-text-primary outline-none hover:bg-bg-inset focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
            >
              Cancel
            </button>
            <button
              ref={confirmRef}
              type="button"
              onClick={confirmModal}
              className="flex h-9 cursor-pointer items-center rounded-control border border-accent px-rc-md text-control font-medium text-accent outline-none hover:bg-accent-wash focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
            >
              {confirmLabel}
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body
  )
}
