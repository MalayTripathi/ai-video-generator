'use client'

import Link from 'next/link'
import { useRef, useState } from 'react'
import { updateProjectTitle } from '../../actions'
import type { ProjectStatus } from '../../types'

function BackIcon() {
  return (
    <svg width="12" height="11" viewBox="0 0 12 11" fill="none" aria-hidden="true">
      <path d="M11 5.5H1.5M5 1.75 1.25 5.5 5 9.25" stroke="currentColor" strokeWidth="1.4" />
    </svg>
  )
}

function StatusBadge({ status }: { status: ProjectStatus }) {
  switch (status) {
    case 'completed':
      return (
        <span className="rounded-badge bg-status-done-bg px-rc-xs py-rc-3xs text-chip font-medium text-status-done-fg">
          Complete
        </span>
      )
    case 'in_progress':
      return (
        <span className="rounded-badge bg-status-active-bg px-rc-xs py-rc-3xs text-chip font-medium text-status-active-fg">
          In progress
        </span>
      )
    case 'failed':
      return (
        <span className="rounded-badge bg-status-failed-bg px-rc-xs py-rc-3xs text-chip font-medium text-status-failed-fg">
          Render failed
        </span>
      )
    case 'draft':
    default:
      return (
        <span className="rounded-badge bg-status-draft-bg px-rc-xs py-rc-3xs text-chip font-medium text-text-secondary">
          Draft
        </span>
      )
  }
}

export function ScriptHeader({
  projectId,
  title,
  onTitleChange,
  status,
}: {
  projectId: string
  title: string
  onTitleChange: (title: string) => void
  status: ProjectStatus
}) {
  const [editing, setEditing] = useState(false)
  const [value, setValue] = useState(title)
  const inputRef = useRef<HTMLInputElement>(null)

  function startEditing() {
    setValue(title)
    setEditing(true)
    requestAnimationFrame(() => inputRef.current?.select())
  }

  async function save() {
    setEditing(false)
    const trimmed = value.trim()
    if (!trimmed || trimmed === title) return
    onTitleChange(trimmed)
    await updateProjectTitle(projectId, trimmed)
  }

  return (
    <div className="flex items-center gap-rc-sm">
      <Link
        href="/dashboard"
        aria-label="Back to dashboard"
        className="-ml-[10.25px] flex h-[30px] w-[30px] items-center justify-center rounded-control text-text-secondary outline-none hover:bg-bg-inset hover:text-text-primary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
      >
        <BackIcon />
      </Link>

      {editing ? (
        <input
          ref={inputRef}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onBlur={save}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              inputRef.current?.blur()
            } else if (e.key === 'Escape') {
              setValue(title)
              setEditing(false)
            }
          }}
          autoFocus
          className="rounded-control bg-transparent text-body font-medium tracking-micro text-text-primary outline-none focus-visible:shadow-[var(--focus-halo)]"
        />
      ) : (
        <button
          type="button"
          onClick={startEditing}
          className="rounded-control text-body font-medium tracking-micro text-text-primary outline-none hover:bg-bg-inset focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
        >
          {title || 'Untitled project'}
        </button>
      )}

      <StatusBadge status={status} />
    </div>
  )
}
