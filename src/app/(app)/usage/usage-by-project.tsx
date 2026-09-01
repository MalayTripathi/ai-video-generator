import { formatCost } from '@/lib/format-cost'
import type { UsageAggregation } from './aggregate'

export function UsageByProject({ aggregation }: { aggregation: UsageAggregation }) {
  if (aggregation.byProject.length === 0) return null

  return (
    <section className="rounded-control border border-border-subtle bg-bg-surface p-rc-lg shadow-card">
      <div className="flex items-baseline justify-between">
        <h2 className="text-section font-medium tracking-snug text-text-primary">Cost by project</h2>
        <span className="text-meta text-text-tertiary">Estimated, settled spend only</span>
      </div>

      <div className="mt-rc-md flex flex-col">
        {aggregation.byProject.map((project) => (
          <details
            key={project.projectId ?? 'deleted-project'}
            className="border-b border-border-subtle py-rc-sm last:border-b-0"
          >
            <summary className="flex cursor-pointer list-none items-center justify-between gap-rc-md [&::-webkit-details-marker]:hidden">
              <div className="flex flex-col gap-rc-3xs">
                <span className="text-ui font-medium text-text-primary">{project.title}</span>
                <span className="text-meta text-text-tertiary">
                  {project.videoTypeLabel ?? '—'} · {project.durationLabel ?? '—'}
                </span>
              </div>
              <span className="text-ui text-text-primary">{formatCost(project.total)}</span>
            </summary>

            <div className="mt-rc-xs flex flex-col gap-rc-2xs pl-rc-md">
              {project.bySteps.map((step) => (
                <div
                  key={`${step.step}:${step.operation}`}
                  className="flex items-center justify-between text-meta text-text-secondary"
                >
                  <span>{step.label}</span>
                  <span>
                    {formatCost(step.cost)} · {step.sharePct.toFixed(0)}%
                  </span>
                </div>
              ))}
            </div>
          </details>
        ))}
      </div>
    </section>
  )
}
