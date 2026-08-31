import { formatCost } from '@/lib/format-cost'
import type { UsageAggregation } from './aggregate'

export function UsageByStep({ aggregation }: { aggregation: UsageAggregation }) {
  if (aggregation.byStep.length === 0) return null

  return (
    <section className="rounded-control border border-border-subtle bg-bg-surface p-rc-lg shadow-card">
      <div className="flex items-baseline justify-between">
        <h2 className="text-section font-medium tracking-snug text-text-primary">Cost by step</h2>
        <span className="text-meta text-text-tertiary">Estimated, settled spend only</span>
      </div>

      <div className="mt-rc-md flex flex-col">
        {aggregation.byStep.map((row) => (
          <div
            key={`${row.step}:${row.operation}`}
            className="flex items-center justify-between gap-rc-md border-b border-border-subtle py-rc-sm last:border-b-0"
          >
            <div className="flex flex-col gap-rc-3xs">
              <span className="text-ui font-medium text-text-primary">{row.label}</span>
              <span className="text-meta text-text-tertiary">
                {row.callCount} {row.callCount === 1 ? 'call' : 'calls'}
              </span>
            </div>

            <div className="flex items-center gap-rc-lg">
              <span className="text-ui text-text-secondary">{formatCost(row.cost)}</span>
              <span className="w-[56px] text-right text-section font-medium text-text-primary">
                {row.sharePct.toFixed(1)}%
              </span>
            </div>
          </div>
        ))}
      </div>
    </section>
  )
}
