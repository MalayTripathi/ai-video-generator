'use client'

import Link from 'next/link'
import { useShots } from './shots-context'

export type WorkbenchTab = 'shots' | 'assets' | 'script'

export function WorkbenchTabs({
  projectId,
  activeTab,
  children,
}: {
  projectId: string
  activeTab: WorkbenchTab
  children: React.ReactNode
}) {
  const { shots } = useShots()
  const elementCount = new Set(shots.flatMap((shot) => shot.elements.map((el) => el.id))).size
  const tabs: { key: WorkbenchTab; label: string; count: number | null }[] = [
    { key: 'shots', label: 'Shots', count: shots.length },
    { key: 'assets', label: 'Assets', count: elementCount },
    { key: 'script', label: 'Script', count: null },
  ]

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-[42px] flex-none items-center gap-rc-lg border-b border-border-subtle px-rc-md">
        {tabs.map((tab) => {
          const active = tab.key === activeTab
          return (
            <Link
              key={tab.key}
              href={`/projects/${projectId}/workbench?tab=${tab.key}`}
              className={
                active
                  ? 'relative flex h-[42px] items-center text-control font-medium text-accent'
                  : 'flex h-[42px] items-center text-control text-text-secondary hover:text-text-primary'
              }
            >
              {tab.label}
              {tab.count !== null && <span className="ml-[5px] font-normal text-text-tertiary">{tab.count}</span>}
              {active && (
                <span className="absolute inset-x-0 bottom-[-1px] h-[2px] rounded-[1px] bg-accent" aria-hidden />
              )}
            </Link>
          )
        })}
      </div>
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-rc-md py-rc-md">
        {children}
      </div>
    </div>
  )
}
