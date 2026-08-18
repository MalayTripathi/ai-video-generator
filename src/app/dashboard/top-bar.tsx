import type { ReactNode } from 'react'
import type { User } from '@supabase/supabase-js'
import { UserMenu } from './user-menu'

export function TopBar({
  user,
  left,
  right,
}: {
  user: User
  left: ReactNode
  right?: ReactNode
}) {
  const name = (user.user_metadata?.full_name as string | undefined)?.trim() || user.email || 'Account'
  const email = user.email ?? ''

  return (
    <header className="flex h-[68px] flex-none items-center justify-between border-b border-border-subtle px-rc-lg lg:px-rc-xl xl:px-rc-2xl">
      {left}
      <div className="flex items-center gap-rc-xs">
        {right}
        <UserMenu name={name} email={email} />
      </div>
    </header>
  )
}

export function SearchButton() {
  return (
    <button
      type="button"
      aria-label="Search"
      className="flex h-8 w-8 items-center justify-center rounded-control text-text-secondary outline-none hover:bg-bg-inset hover:text-text-primary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
    >
      <svg width="15" height="15" viewBox="0 0 15 15" fill="none" aria-hidden="true">
        <circle cx="6.5" cy="6.5" r="4.75" stroke="currentColor" strokeWidth="1.4" />
        <path d="M10.25 10.25 13.5 13.5" stroke="currentColor" strokeWidth="1.4" />
      </svg>
    </button>
  )
}
