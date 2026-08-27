'use client'

import { useMemo, useState } from 'react'
import { EmptyState } from './empty-state'
import { ProjectCard } from './project-card'
import type { Project } from './types'

type FilterKey = 'all' | 'draft' | 'in_progress' | 'completed'

const FILTERS: { key: FilterKey; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'draft', label: 'Drafts' },
  { key: 'in_progress', label: 'In progress' },
  { key: 'completed', label: 'Completed' },
]

export function ProjectGrid({ projects }: { projects: Project[] }) {
  const [filter, setFilter] = useState<FilterKey>('all')

  const counts = useMemo(() => {
    const c: Record<FilterKey, number> = { all: projects.length, draft: 0, in_progress: 0, completed: 0 }
    for (const project of projects) {
      if (project.status === 'draft' || project.status === 'in_progress' || project.status === 'completed') {
        c[project.status]++
      }
    }
    return c
  }, [projects])

  const visible = useMemo(
    () => (filter === 'all' ? projects : projects.filter((p) => p.status === filter)),
    [projects, filter],
  )

  if (projects.length === 0) {
    return (
      <div className="flex flex-1 flex-col">
        <FilterRow filter={filter} onChange={setFilter} counts={counts} />
        <EmptyState />
      </div>
    )
  }

  return (
    <div className="flex flex-1 flex-col">
      <FilterRow filter={filter} onChange={setFilter} counts={counts} />
      {visible.length === 0 ? (
        <div className="flex flex-1 items-center justify-center px-rc-lg py-rc-2xl lg:px-rc-xl xl:px-rc-2xl">
          <p className="text-ui text-text-secondary">No projects in this filter.</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-rc-lg px-rc-lg py-rc-lg pb-rc-2xl md:grid-cols-2 lg:px-rc-xl xl:grid-cols-3 xl:px-rc-2xl">
          {visible.map((project) => (
            <ProjectCard key={project.id} project={project} />
          ))}
        </div>
      )}
    </div>
  )
}

function FilterRow({
  filter,
  onChange,
  counts,
}: {
  filter: FilterKey
  onChange: (f: FilterKey) => void
  counts: Record<FilterKey, number>
}) {
  return (
    <div className="flex items-center gap-[4px] px-rc-lg pt-rc-lg lg:px-rc-xl xl:px-rc-2xl">
      {FILTERS.map(({ key, label }) => {
        const active = filter === key
        return (
          <button
            key={key}
            type="button"
            onClick={() => onChange(key)}
            className={`cursor-pointer rounded-control px-rc-sm py-rc-2xs text-small outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent ${
              active
                ? 'bg-bg-selected font-medium text-text-primary'
                : 'text-text-secondary hover:bg-bg-inset hover:text-text-primary'
            }`}
          >
            {label} {counts[key]}
          </button>
        )
      })}
    </div>
  )
}
