import { formatCost } from '@/lib/format-cost'
import type { UsageAggregation } from './aggregate'

export function UsageSummary({ aggregation }: { aggregation: UsageAggregation }) {
  const { settledTotal, pendingTotal, projectsWithSpendCount } = aggregation

  return (
    <section className="rounded-control border border-border-subtle bg-bg-surface p-rc-lg shadow-card">
      <div className="flex items-baseline justify-between">
        <h2 className="text-section font-medium tracking-snug text-text-primary">Summary</h2>
        <span className="text-meta text-text-tertiary">
          Estimated from list pricing, not a provider invoice
        </span>
      </div>

      <div className="mt-rc-md grid grid-cols-1 gap-rc-lg sm:grid-cols-3">
        <div className="flex flex-col gap-rc-3xs">
          <span className="text-label uppercase tracking-label text-text-tertiary">Settled spend</span>
          <span className="text-screen font-medium tracking-tight text-text-primary">
            {formatCost(settledTotal)}
          </span>
        </div>

        <div className="flex flex-col gap-rc-3xs">
          <span className="text-label uppercase tracking-label text-text-tertiary">In-flight (pending)</span>
          <span className="text-screen font-medium tracking-tight text-text-primary">
            {formatCost(pendingTotal)}
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
