'use client'

import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

// The one project-delete confirm (canvas §19 C1-C5), opened from the dashboard card menu
// and the settings drawer. Built on the delete-shot confirm's shape with a typed check: the
// button enables only on an exact, case-sensitive "Delete". The server decides whether the
// project is busy, so the modal opens confirmable and turns to the refused state on a 409.

const CONFIRM_WORD = 'Delete'

type Phase = 'confirm' | 'deleting' | 'refused' | 'error'

// Mounted only while open, so every opening starts in the empty confirm state.
export function DeleteProjectModal({
  projectId,
  title,
  onClose,
  onDeleted,
}: {
  projectId: string
  title: string
  onClose: () => void
  onDeleted: () => void
}) {
  const [phase, setPhase] = useState<Phase>('confirm')
  const [text, setText] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)
  const busy = phase === 'deleting'
  const match = text === CONFIRM_WORD

  useEffect(() => {
    if (phase !== 'refused') inputRef.current?.focus()
  }, [phase])

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape' && !busy) onClose()
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [busy, onClose])

  async function submit() {
    if (!match || busy) return
    setPhase('deleting')
    try {
      const response = await fetch(`/api/projects/${projectId}`, { method: 'DELETE' })
      if (response.ok) {
        onDeleted()
        return
      }
      const data = (await response.json().catch(() => null)) as { code?: string } | null
      setPhase(response.status === 409 && data?.code === 'active' ? 'refused' : 'error')
    } catch {
      setPhase('error')
    }
  }

  const close = () => {
    if (!busy) onClose()
  }

  const ghostButton =
    'flex h-[34px] cursor-pointer items-center rounded-control border border-border-strong bg-transparent px-rc-md text-control text-text-primary outline-none hover:bg-bg-inset focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:cursor-not-allowed disabled:opacity-45'

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-rc-md" onClick={close}>
      <div
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="delete-project-title"
        onClick={(e) => e.stopPropagation()}
        className="flex w-full max-w-[420px] flex-col gap-[10px] rounded-frame border border-border-subtle bg-bg-surface p-rc-md text-left text-text-primary shadow-card-hover"
      >
        <span id="delete-project-title" className="text-section font-medium tracking-micro text-pretty">
          Delete “{title}”?
        </span>

        {phase === 'refused' ? (
          <>
            <span className="text-small leading-[1.55] text-text-secondary">
              A generation is running in this project. Wait for it to finish, then delete.
            </span>
            <span className="mt-rc-2xs flex justify-end gap-rc-xs">
              <button type="button" onClick={close} className={ghostButton}>
                Close
              </button>
            </span>
          </>
        ) : (
          <>
            <span className="text-small leading-[1.55] text-text-secondary text-pretty">
              This permanently deletes the project’s shots, images, voiceover, music, video, exports and chat. It can’t
              be undone.
            </span>
            <span className="text-small leading-[1.55] text-text-secondary">Your credit history is kept.</span>
            <label className={`mt-rc-2xs flex flex-col gap-[5px] ${busy ? 'opacity-45' : ''}`}>
              <span className="text-meta text-text-secondary">
                Type <em>Delete</em> to confirm
              </span>
              <input
                ref={inputRef}
                value={text}
                onChange={(e) => setText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void submit()
                }}
                disabled={busy}
                autoComplete="off"
                spellCheck={false}
                className="h-[38px] rounded-badge border border-border-strong bg-bg-surface px-[11px] py-[9px] text-control text-text-primary outline-none focus:border-accent focus:shadow-focus-halo disabled:cursor-not-allowed"
              />
            </label>
            {phase === 'error' && (
              <span role="alert" className="flex items-center gap-[7px] text-small text-status-failed-fg">
                <svg width="13" height="13" viewBox="0 0 12 12" fill="none" aria-hidden="true" className="flex-none">
                  <circle cx="6" cy="6" r="5.25" stroke="currentColor" strokeWidth="1.2" />
                  <rect x="5.4" y="3" width="1.2" height="3.6" fill="currentColor" />
                  <rect x="5.4" y="7.8" width="1.2" height="1.2" fill="currentColor" />
                </svg>
                Couldn’t delete the project. Try again.
              </span>
            )}
            <span className="mt-rc-2xs flex justify-end gap-rc-xs">
              <button type="button" onClick={close} disabled={busy} className={ghostButton}>
                Cancel
              </button>
              <button
                type="button"
                onClick={() => void submit()}
                disabled={busy || !match}
                aria-busy={busy}
                className={`flex h-[34px] items-center gap-rc-xs rounded-control border border-status-failed-fg bg-transparent px-rc-md text-control font-medium text-status-failed-fg outline-none hover:bg-status-failed-bg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent ${
                  busy ? 'cursor-progress' : match ? 'cursor-pointer' : 'cursor-not-allowed opacity-45'
                }`}
              >
                {busy && (
                  <span
                    aria-hidden
                    className="block h-3 w-3 flex-none rounded-full border-[1.5px] border-status-failed-bg border-t-status-failed-fg"
                    style={{ animation: 'rc-spin 0.7s linear infinite' }}
                  />
                )}
                {busy ? 'Deleting…' : 'Delete project'}
              </button>
            </span>
          </>
        )}
      </div>
    </div>,
    document.body
  )
}
