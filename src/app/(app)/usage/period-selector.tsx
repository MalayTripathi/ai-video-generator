'use client'

import type { ReactNode } from 'react'
import Link from 'next/link'
import { useLinkStatus } from 'next/link'
import { PERIODS, type Period } from './period'

// Same-route/searchParams-only navigations (this Link's href only changes
// `period`) land inside an already-resolved Suspense boundary, so
// usage/loading.tsx's fallback never re-fires - Next/React keep the stale
// period's numbers on screen until the new payload streams in. This inline
// hint is the documented fix (useLinkStatus, not another loading.tsx). The
// `delay-100` keeps a fast response from flashing the dimmed state at all.
function PeriodLabel({ children }: { children: ReactNode }) {
  const { pending } = useLinkStatus()
  return (
    <span className={`transition-opacity delay-100 duration-200 ${pending ? 'opacity-50' : 'opacity-100'}`}>
      {children}
    </span>
  )
}

export function PeriodSelector({ active }: { active: Period }) {
  return (
    <div className="flex items-center gap-[4px] px-rc-lg pt-rc-lg lg:px-rc-xl xl:px-rc-2xl">
      {PERIODS.map(({ key, label }) => {
        const isActive = key === active
        return (
          <Link
            key={key}
            href={`/usage?period=${key}`}
            className={`rounded-control px-rc-sm py-rc-2xs text-small outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent ${
              isActive
                ? 'bg-bg-selected font-medium text-text-primary'
                : 'text-text-secondary hover:bg-bg-inset hover:text-text-primary'
            }`}
          >
            <PeriodLabel>{label}</PeriodLabel>
          </Link>
        )
      })}
    </div>
  )
}
