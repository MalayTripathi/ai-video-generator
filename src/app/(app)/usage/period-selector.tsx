import Link from 'next/link'
import { PERIODS, type Period } from './period'

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
            {label}
          </Link>
        )
      })}
    </div>
  )
}
