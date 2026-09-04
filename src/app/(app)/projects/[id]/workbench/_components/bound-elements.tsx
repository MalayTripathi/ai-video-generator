import { memo } from 'react'
import { Spinner } from '@/components/spinner'
import type { DisplayElement } from './types'

function elementDotClassName(el: DisplayElement) {
  if (el.reference_image_path) return 'bg-status-done-fg'
  if (el.status === 'generating') return 'bg-status-active-fg'
  if (el.status === 'failed') return 'bg-status-failed-fg'
  return 'bg-border-strong' // pending / no reference - the only state reachable this task
}

// Canvas: "Bound element tiles" close-up. Tile content is driven entirely by the
// element's own already-loaded data (reference_image_path/status) - no new interactivity.
// The hover-to-unbind overlay the canvas also shows is deliberately not built here:
// unbinding is real functionality that belongs to C5, and a button that visually invites
// a click but does nothing would be worse than not having it - this stays inert exactly
// like the camera dropdowns and Delete shot were before their own slices landed.
function ElementTile({ el }: { el: DisplayElement }) {
  if (el.status === 'failed') {
    return (
      <div className="flex h-[60px] w-[60px] flex-none items-center justify-center rounded-badge bg-status-failed-bg text-status-failed-fg">
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <circle cx="8" cy="8" r="6.5" stroke="currentColor" strokeWidth="1.3" />
          <path d="M8 4.6v4.2" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          <circle cx="8" cy="11.4" r="1" fill="currentColor" />
        </svg>
      </div>
    )
  }

  if (el.status === 'generating') {
    return (
      <div className="flex h-[60px] w-[60px] flex-none animate-pulse items-center justify-center rounded-badge bg-skeleton-base">
        <Spinner className="h-4 w-4" thickness={1.5} />
      </div>
    )
  }

  if (el.reference_image_path) {
    return (
      <div
        className="h-[60px] w-[60px] flex-none rounded-badge border border-border-subtle"
        style={{
          backgroundImage: 'repeating-linear-gradient(135deg, var(--stripe-a) 0 7px, var(--stripe-b) 7px 14px)',
        }}
      />
    )
  }

  return (
    <div className="flex h-[60px] w-[60px] flex-none items-center justify-center rounded-badge border border-dashed border-border-muted bg-bg-well text-body text-text-quiet">
      {el.name.charAt(0).toUpperCase()}
    </div>
  )
}

export const BoundElements = memo(function BoundElements({ elements }: { elements: DisplayElement[] }) {
  return (
    <div className="flex flex-col gap-rc-2xs">
      <span className="text-label font-medium uppercase leading-4 tracking-label text-text-tertiary">Bound elements</span>
      <div className="flex flex-wrap items-start gap-rc-sm">
        {elements.map((el) => (
          <div key={el.id} className="flex w-[60px] flex-col items-center gap-[5px]">
            <ElementTile el={el} />
            <span className="flex max-w-full items-center gap-[5px] text-meta text-text-secondary">
              <span className={`h-[5px] w-[5px] flex-none rounded-full ${elementDotClassName(el)}`} aria-hidden />
              <span className="truncate">{el.name}</span>
            </span>
          </div>
        ))}
        <span
          aria-hidden
          className="flex h-[60px] w-[60px] flex-none cursor-default items-center justify-center rounded-badge border border-dashed border-border-strong text-text-tertiary"
        >
          <svg width="13" height="13" viewBox="0 0 13 13" fill="none" aria-hidden="true">
            <rect x="5.75" y="1" width="1.5" height="11" fill="currentColor" />
            <rect x="1" y="5.75" width="11" height="1.5" fill="currentColor" />
          </svg>
        </span>
      </div>
    </div>
  )
})
