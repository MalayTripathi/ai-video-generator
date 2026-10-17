'use client'

import { useEffect, useMemo, useState } from 'react'
import { displayTitle } from '@/lib/display-title'
import { DeleteProjectModal } from '@/components/delete-project-modal'
import { EmptyState } from './empty-state'
import { ProjectCard } from './project-card'
import { ProjectCardMenu } from './project-card-menu'
import type { Project } from './types'

const TOAST_MS = 4000

type FilterKey = 'all' | 'draft' | 'in_progress' | 'completed'

const FILTERS: { key: FilterKey; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'draft', label: 'Drafts' },
  { key: 'in_progress', label: 'In progress' },
  { key: 'completed', label: 'Completed' },
]

export function ProjectGrid({ projects: initialProjects, justDeleted }: { projects: Project[]; justDeleted: boolean }) {
  const [filter, setFilter] = useState<FilterKey>('all')
  // Deleting removes the card here - no refetch, and no per-card read for the menu.
  const [projects, setProjects] = useState(initialProjects)
  const [deleteTarget, setDeleteTarget] = useState<Project | null>(null)
  const [toast, setToast] = useState(justDeleted)

  useEffect(() => {
    if (!toast) return
    // A delete from inside the project lands here with ?deleted=1; drop it from the URL
    // without a navigation, so a reload doesn't show the toast again.
    if (window.location.search.includes('deleted=')) window.history.replaceState(null, '', '/dashboard')
    const timer = setTimeout(() => setToast(false), TOAST_MS)
    return () => clearTimeout(timer)
  }, [toast])

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

  const overlays = (
    <>
      {deleteTarget && (
        <DeleteProjectModal
          projectId={deleteTarget.id}
          title={displayTitle(deleteTarget)}
          onClose={() => setDeleteTarget(null)}
          onDeleted={() => {
            setProjects((list) => list.filter((p) => p.id !== deleteTarget.id))
            setDeleteTarget(null)
            setToast(true)
          }}
        />
      )}
      {toast && <ProjectDeletedToast />}
    </>
  )

  if (projects.length === 0) {
    return (
      <div className="flex flex-1 flex-col">
        <FilterRow filter={filter} onChange={setFilter} counts={counts} />
        <EmptyState />
        {overlays}
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
            // `grid` so the card link still fills its cell; the menu sits beside it, not in it.
            <div key={project.id} className="relative grid">
              <ProjectCard project={project} />
              <ProjectCardMenu title={displayTitle(project)} onDelete={() => setDeleteTarget(project)} />
            </div>
          ))}
        </div>
      )}
      {overlays}
    </div>
  )
}

function ProjectDeletedToast() {
  return (
    <div
      role="status"
      className="fixed bottom-[28px] left-1/2 z-40 flex -translate-x-1/2 items-center gap-[9px] rounded-control bg-rail-bg py-[10px] pr-rc-md pl-[13px] text-small font-medium whitespace-nowrap text-rail-fg shadow-card-hover"
    >
      <svg width="13" height="13" viewBox="0 0 14 14" fill="none" aria-hidden="true">
        <path d="M2 7.25 5.5 10.75 12 3.75" stroke="currentColor" strokeWidth="1.5" />
      </svg>
      Project deleted
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
