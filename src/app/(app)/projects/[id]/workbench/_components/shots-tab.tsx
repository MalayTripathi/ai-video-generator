'use client'

import { Spinner } from '@/components/spinner'
import { ShotCard } from './shot-card'
import { useShots } from './shots-context'
import type { DisplayShot } from './types'

function SkeletonBar({ width, height }: { width: string; height: string }) {
  return <span className="rounded-[3px] bg-skeleton-base" style={{ width, height }} />
}

function GeneratingSkeleton() {
  return (
    <div className="flex flex-col gap-rc-sm">
      <div className="flex items-center gap-rc-xs text-small text-text-secondary">
        <Spinner />
        Writing shots from your brief — about 20 seconds.
      </div>
      <div className="flex flex-col gap-rc-xs rounded-control border border-border-subtle bg-bg-surface p-[12px_14px]">
        <SkeletonBar width="88px" height="11px" />
        <SkeletonBar width="82%" height="13px" />
        <SkeletonBar width="64%" height="11px" />
      </div>
      <div className="flex flex-col gap-rc-xs rounded-control border border-border-subtle bg-bg-surface p-[12px_14px]">
        <SkeletonBar width="76px" height="11px" />
        <SkeletonBar width="70%" height="13px" />
        <SkeletonBar width="52%" height="11px" />
      </div>
    </div>
  )
}

function GenerationFailedBanner({ onRetry }: { onRetry: () => void }) {
  return (
    <div className="flex items-center justify-between gap-rc-md rounded-control border border-status-failed-line bg-status-failed-bg p-[14px_16px]">
      <div className="flex flex-col gap-[3px]">
        <span className="text-control font-medium text-banner-failed-title">Couldn&rsquo;t build the shot list</span>
        <span className="text-small leading-[1.5] text-banner-failed-body">
          The model returned nothing usable. Your brief is saved — nothing was charged.
        </span>
      </div>
      <div className="flex flex-none gap-rc-xs">
        <span className="flex h-8 cursor-not-allowed items-center rounded-control border border-status-failed-line px-rc-sm text-small text-banner-failed-title opacity-60">
          Edit the brief
        </span>
        <button
          type="button"
          onClick={onRetry}
          className="flex h-8 cursor-pointer items-center rounded-control border border-accent bg-bg-surface px-rc-sm text-small font-medium text-accent hover:bg-accent-wash"
        >
          Try again
        </button>
      </div>
    </div>
  )
}

function NoShotsEmptyState({ onRebuild }: { onRebuild: () => void }) {
  return (
    <div className="flex flex-col items-center gap-rc-xs rounded-control border border-dashed border-border-strong p-rc-lg text-center">
      <span className="text-body font-medium text-text-primary">No shots left</span>
      <span className="max-w-[420px] text-small leading-[1.5] text-text-secondary">
        A film needs at least one. Add a shot and write it yourself, or have the agent rebuild the list from
        your brief.
      </span>
      <div className="mt-rc-2xs flex gap-rc-xs">
        <span className="flex h-8 cursor-not-allowed items-center rounded-control border border-border-strong px-rc-sm text-small opacity-60">
          Add shot
        </span>
        <button
          type="button"
          onClick={onRebuild}
          className="flex h-8 cursor-pointer items-center gap-[6px] rounded-control border border-accent px-rc-sm text-small font-medium text-accent hover:bg-accent-wash"
        >
          Rebuild with the agent
        </button>
      </div>
    </div>
  )
}

function withHeadings(shots: DisplayShot[]) {
  const sorted = [...shots].sort((a, b) => a.order_index - b.order_index)
  return sorted.reduce<{ shot: DisplayShot; showHeading: boolean }[]>((rows, shot) => {
    const previous = rows[rows.length - 1]
    const showHeading = !previous || previous.shot.section_label !== shot.section_label
    rows.push({ shot, showHeading })
    return rows
  }, [])
}

function ShotList({ shots }: { shots: DisplayShot[] }) {
  return (
    <div className="flex flex-col gap-rc-sm">
      {withHeadings(shots).map(({ shot, showHeading }) => (
        <div key={shot.id} className="flex flex-col gap-rc-sm">
          {showHeading && shot.section_label && (
            <div className="text-label uppercase tracking-label text-text-tertiary">{shot.section_label}</div>
          )}
          <ShotCard shot={shot} />
        </div>
      ))}
    </div>
  )
}

export function ShotsTab() {
  const { shots, phase, retry } = useShots()

  if (phase === 'generating') return <GeneratingSkeleton />
  if (phase === 'failed') return <GenerationFailedBanner onRetry={retry} />
  if (shots.length === 0) return <NoShotsEmptyState onRebuild={retry} />
  return <ShotList shots={shots} />
}
