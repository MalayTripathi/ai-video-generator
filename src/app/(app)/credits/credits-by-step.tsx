import { formatCredits } from '@/lib/format-credits'
import type { CreditsPeriodAggregation } from './aggregate'

export function CreditsByStep({ aggregation }: { aggregation: CreditsPeriodAggregation }) {
  if (aggregation.byStep.length === 0) return null

  return (
    <section className="rounded-control border border-border-subtle bg-bg-surface p-rc-lg shadow-card">
      <div className="flex items-baseline justify-between">
        <h2 className="text-section font-medium tracking-snug text-text-primary">Cost by step</h2>
      </div>

      <div className="mt-rc-md flex flex-col gap-rc-sm">
        {aggregation.byStep.map((group) => (
          <div key={group.step} className="flex flex-col gap-rc-2xs">
            <div className="flex items-center justify-between text-ui font-medium text-text-primary">
              <span>{group.label}</span>
              <span>{formatCredits(group.credits)}</span>
            </div>

            <div className="flex flex-col pl-rc-md">
              {group.operations.map((row) => (
                <div
                  key={`${row.step}:${row.operation}`}
                  className="flex items-center justify-between gap-rc-md border-b border-border-subtle py-rc-sm last:border-b-0"
                >
                  <div className="flex flex-col gap-rc-3xs">
                    <span className="text-ui text-text-secondary">{row.label}</span>
                    <span className="text-meta text-text-tertiary">{row.unitLabel}</span>
                  </div>

                  <div className="flex items-center gap-rc-lg">
                    <span className="text-ui text-text-secondary">{formatCredits(row.credits)}</span>
                    <span className="w-[56px] text-right text-section font-medium text-text-primary">
                      {row.sharePct.toFixed(1)}%
                    </span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </section>
  )
}
