'use client'

import type { ReactNode } from 'react'
import Link from 'next/link'
import { useLinkStatus } from 'next/link'
import { PERIODS, type Period } from '../usage/period'

// Same pattern as usage/period-selector.tsx (same-route searchParams-only navigations
// land inside an already-resolved Suspense boundary, so loading.tsx never re-fires) -
// cloned rather than shared because the href differs; Period/PERIODS themselves are
// imported straight from usage/period.ts rather than redefined.
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
            href={`/credits?period=${key}`}
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
