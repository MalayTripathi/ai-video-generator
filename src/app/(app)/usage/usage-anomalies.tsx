import { formatCost } from '@/lib/format-cost'
import type { UsageAggregation } from './aggregate'

export function UsageAnomalies({ aggregation }: { aggregation: UsageAggregation }) {
  const { stalePending, blocked, failed } = aggregation.anomalies
  const { calibration } = aggregation
  if (stalePending.count === 0 && blocked.count === 0 && failed.count === 0 && calibration.count === 0) return null

  return (
    <section className="rounded-control border border-border-subtle bg-bg-surface p-rc-lg shadow-card">
      <div className="flex items-baseline justify-between">
        <h2 className="text-section font-medium tracking-snug text-text-primary">Anomalies</h2>
        <span className="text-meta text-text-tertiary">Estimated</span>
      </div>

      <div className="mt-rc-md flex flex-col gap-rc-sm">
        {stalePending.count > 0 && (
          <div className="flex flex-col gap-rc-3xs rounded-badge bg-status-active-bg px-rc-sm py-rc-xs">
            <span className="text-ui font-medium text-status-active-fg">
              {stalePending.count} stuck pending, {formatCost(stalePending.total)}
            </span>
            <p className="text-meta text-status-active-fg">
              These calls were billed against but never settled — likely a request that died
              mid-flight.
            </p>
          </div>
        )}

        {blocked.count > 0 && (
          <div className="flex flex-col gap-rc-3xs rounded-badge bg-bg-inset px-rc-sm py-rc-xs">
            <span className="text-ui font-medium text-text-secondary">
              {blocked.count} blocked, {formatCost(blocked.total)}
            </span>
            <p className="text-meta text-text-tertiary">
              These calls were refused before any request was sent and cost nothing.
            </p>
          </div>
        )}

        {failed.count > 0 && (
          <div className="flex flex-col gap-rc-3xs rounded-badge bg-status-failed-bg px-rc-sm py-rc-xs">
            <span className="text-ui font-medium text-status-failed-fg">
              {failed.count} failed, {formatCost(failed.total)}
            </span>
            <p className="text-meta text-status-failed-fg">
              These calls did not complete successfully but were still billed for what was used.
            </p>
          </div>
        )}

        {calibration.count > 0 && (
          <div className="flex flex-col gap-rc-3xs rounded-badge bg-bg-inset px-rc-sm py-rc-xs">
            <span className="text-ui font-medium text-text-secondary">Estimate calibration</span>
            <p className="text-meta text-text-tertiary">
              Across {calibration.count} settled call{calibration.count === 1 ? '' : 's'}, actual cost averaged{' '}
              {calibration.meanDelta >= 0 ? '+' : '−'}
              {formatCost(Math.abs(calibration.meanDelta))} vs. the pre-flight quote
              {calibration.meanRatio !== null && ` (${calibration.meanRatio.toFixed(2)}× on average)`}. Diagnostic
              only — not additional spend.
            </p>
          </div>
        )}
      </div>
    </section>
  )
}
