import { formatCredits } from '@/lib/format-credits'
import type { CreditsPeriodAggregation } from './aggregate'

export function CreditsSummary({
  balance,
  period,
}: {
  balance: number
  period: CreditsPeriodAggregation
}) {
  const { spentThisPeriod, projectsWithSpendCount } = period

  return (
    <section className="rounded-control border border-border-subtle bg-bg-surface p-rc-lg shadow-card">
      <div className="flex items-baseline justify-between">
        <h2 className="text-section font-medium tracking-snug text-text-primary">Summary</h2>
      </div>

      <div className="mt-rc-md grid grid-cols-1 gap-rc-lg sm:grid-cols-3">
        <div className="flex flex-col gap-rc-3xs">
          <span className="text-label uppercase tracking-label text-text-tertiary">Balance</span>
          <span data-testid="credits-balance" className="text-screen font-medium tracking-tight text-text-primary">
            {formatCredits(balance)}
          </span>
          <span className="text-meta text-text-tertiary">All time — not this period</span>
        </div>

        <div className="flex flex-col gap-rc-3xs">
          <span className="text-label uppercase tracking-label text-text-tertiary">Spent this period</span>
          <span data-testid="credits-spent-this-period" className="text-screen font-medium tracking-tight text-text-primary">
            {formatCredits(spentThisPeriod)}
          </span>
        </div>

        <div className="flex flex-col gap-rc-3xs">
          <span className="text-label uppercase tracking-label text-text-tertiary">Projects with spend</span>
          <span className="text-screen font-medium tracking-tight text-text-primary">{projectsWithSpendCount}</span>
        </div>
      </div>
    </section>
  )
}
