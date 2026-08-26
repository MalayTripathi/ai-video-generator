'use client'

import { useFormStatus } from 'react-dom'

export function BuildButton({ disabled }: { disabled: boolean }) {
  const { pending } = useFormStatus()

  if (pending) {
    return (
      <button
        type="submit"
        disabled
        className="flex h-11 w-full items-center justify-center gap-rc-xs rounded-control border border-accent-active bg-accent-wash-strong text-control font-medium text-accent-active"
      >
        <span
          aria-hidden
          className="h-[13px] w-[13px] rounded-full border-[1.5px] border-accent-faint border-t-accent-active"
          style={{ animation: 'rc-spin 0.7s linear infinite' }}
        />
        Building workbench…
      </button>
    )
  }

  return (
    <button
      type="submit"
      disabled={disabled}
      className={
        disabled
          ? 'flex h-11 w-full cursor-not-allowed items-center justify-center rounded-control border border-border-subtle bg-bg-inset text-control font-medium text-text-tertiary'
          : 'flex h-11 w-full cursor-pointer items-center justify-center rounded-control border border-accent bg-accent text-control font-medium text-white outline-none hover:bg-accent-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent active:bg-accent-active'
      }
    >
      Build workbench
    </button>
  )
}
