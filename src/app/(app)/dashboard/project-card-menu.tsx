'use client'

import { useEffect, useRef, useState } from 'react'

// The card's "⋯" menu (canvas 19 A1/A2): a sibling of the card link, laid over its top-right
// corner - never nested inside the anchor, so clicking it never opens the project. One item,
// Delete project, which stays last as items are added above it.
export function ProjectCardMenu({ title, onDelete }: { title: string; onDelete: () => void }) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    function handlePointer(e: MouseEvent) {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false)
    }
    function handleKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', handlePointer)
    document.addEventListener('keydown', handleKey)
    return () => {
      document.removeEventListener('mousedown', handlePointer)
      document.removeEventListener('keydown', handleKey)
    }
  }, [open])

  return (
    <div ref={rootRef} className="absolute top-[calc(var(--spacing-rc-sm)+8px)] right-[calc(var(--spacing-rc-sm)+8px)]">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-label={`Actions for ${title}`}
        aria-haspopup="menu"
        aria-expanded={open}
        data-testid="project-card-menu-button"
        className={`flex h-[28px] w-[28px] cursor-pointer items-center justify-center rounded-badge border shadow-card outline-none hover:border-border-strong hover:bg-bg-inset hover:text-text-primary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent ${
          open ? 'border-border-strong bg-bg-inset text-text-primary' : 'border-border-subtle bg-bg-surface text-text-secondary'
        }`}
      >
        <svg width="14" height="14" viewBox="0 0 14 14" fill="currentColor" aria-hidden="true">
          <circle cx="2.75" cy="7" r="1.25" />
          <circle cx="7" cy="7" r="1.25" />
          <circle cx="11.25" cy="7" r="1.25" />
        </svg>
      </button>
      {open && (
        <div
          role="menu"
          aria-label="Project actions"
          className="absolute top-[32px] right-0 z-[5] flex w-[196px] flex-col gap-[2px] rounded-control border border-border-subtle bg-bg-surface p-[4px] shadow-card-hover"
        >
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setOpen(false)
              onDelete()
            }}
            className="flex h-[34px] cursor-pointer items-center gap-[9px] rounded-badge bg-transparent px-[10px] text-left text-small font-medium text-status-failed-fg outline-none hover:bg-status-failed-bg focus-visible:bg-status-failed-bg"
          >
            <svg width="13" height="13" viewBox="0 0 14 14" fill="none" aria-hidden="true">
              <path
                d="M1.75 3.5h10.5M5.25 3.5V2h3.5v1.5M3 3.5l.6 8.75h6.8L11 3.5M5.75 6v4M8.25 6v4"
                stroke="currentColor"
                strokeWidth="1.25"
              />
            </svg>
            Delete project
          </button>
        </div>
      )}
    </div>
  )
}
