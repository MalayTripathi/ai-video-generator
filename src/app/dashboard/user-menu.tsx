'use client'

import { useEffect, useRef, useState } from 'react'
import { signOut } from './actions'

function getInitials(name: string) {
  const parts = name.trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return '?'
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase()
  return (parts[0]![0]! + parts[parts.length - 1]![0]!).toUpperCase()
}

function getShortName(name: string) {
  const parts = name.trim().split(/\s+/).filter(Boolean)
  if (parts.length <= 1) return name
  return `${parts[0]} ${parts[parts.length - 1]![0]}.`
}

export function UserMenu({ name, email }: { name: string; email: string }) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    function handlePointerDown(e: PointerEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('pointerdown', handlePointerDown)
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown)
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [])

  const initials = getInitials(name)
  const shortName = getShortName(name)

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-haspopup="menu"
        className="flex cursor-pointer items-center gap-rc-xs rounded-control py-[4px] pl-[4px] pr-rc-xs outline-none hover:bg-bg-inset focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
      >
        <span className="flex h-[26px] w-[26px] items-center justify-center rounded-full bg-accent-wash-strong text-mono font-medium tracking-[0.02em] text-accent-active">
          {initials}
        </span>
        <span className="text-small text-text-secondary">{shortName}</span>
        <svg width="9" height="6" viewBox="0 0 9 6" fill="none" aria-hidden="true">
          <path d="M1 1.25 4.5 4.75 8 1.25" stroke="currentColor" strokeWidth="1.3" />
        </svg>
      </button>

      {open && (
        <div
          role="menu"
          className="absolute right-0 top-[calc(100%+6px)] z-10 w-56 rounded-control border border-border-subtle bg-bg-surface p-rc-2xs shadow-card-hover"
        >
          <div className="px-rc-xs py-rc-2xs">
            <p className="truncate text-small font-medium text-text-primary">{name}</p>
            <p className="truncate text-meta text-text-tertiary">{email}</p>
          </div>
          <div className="my-rc-2xs h-px bg-border-subtle" />
          <form action={signOut}>
            <button
              type="submit"
              role="menuitem"
              className="w-full cursor-pointer rounded-badge px-rc-xs py-rc-2xs text-left text-small text-text-primary outline-none hover:bg-bg-inset focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
            >
              Sign out
            </button>
          </form>
        </div>
      )}
    </div>
  )
}
