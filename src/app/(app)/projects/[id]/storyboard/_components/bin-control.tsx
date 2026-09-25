'use client'

import { useEffect, useRef, useState } from 'react'
import { formatClockTime } from '@/lib/format-clock-time'
import { filmDuration } from '@/lib/storyboard/timeline'
import { useStoryboard } from './storyboard-context'
import { formatSeconds, shotName } from './shot-block'

function BinIcon() {
  return (
    <svg width="11" height="12" viewBox="0 0 11 12" fill="none" aria-hidden="true">
      <path d="M1 3h9M4 3V1.5h3V3M2.2 3l.5 7.5h5.6L8.8 3" stroke="currentColor" strokeWidth="1.2" />
    </svg>
  )
}

export function binLabel(count: number): string {
  return `Bin · ${count} removed ${count === 1 ? 'shot' : 'shots'}`
}

// The Bin control (canvas 15c b, with the icon-and-count revision): it exists only while
// something is in the bin, so an empty bin takes no room in the header. Opens the Removed
// shots popover, where Restore returns a shot to the slot it left.
export function BinControl() {
  const { binnedShots, setBinned, readOnly } = useStoryboard()
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  const count = binnedShots.length
  const shown = open && count > 0

  useEffect(() => {
    if (!shown) return
    const outside = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false)
    }
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    window.addEventListener('pointerdown', outside)
    window.addEventListener('keydown', key)
    return () => {
      window.removeEventListener('pointerdown', outside)
      window.removeEventListener('keydown', key)
    }
  }, [shown])

  if (count === 0) return null
  const label = binLabel(count)

  return (
    <div ref={root} className="relative flex-none">
      <button
        type="button"
        data-testid="bin-control"
        title={label}
        aria-label={label}
        aria-expanded={shown}
        aria-haspopup="dialog"
        onClick={() => setOpen((v) => !v)}
        className="flex h-[28px] cursor-pointer items-center gap-[6px] rounded-control border border-border-subtle px-[9px] text-small text-text-secondary hover:border-border-strong-hover hover:bg-bg-inset"
      >
        <BinIcon />
        <span data-testid="bin-count" className="font-mono text-mono text-text-primary">
          {count}
        </span>
      </button>

      {shown && (
        <div
          role="dialog"
          aria-label="Removed shots"
          data-testid="bin-popover"
          className="absolute right-0 top-[34px] z-30 flex w-[320px] flex-col rounded-frame border border-border-strong bg-bg-canvas shadow-card"
        >
          <div className="flex items-baseline gap-[8px] border-b border-border-subtle p-[11px_14px]">
            <span className="flex-1 text-small font-medium">Removed shots</span>
            <span className="text-meta text-text-quiet">restoring is free</span>
          </div>
          <ul className="flex max-h-[260px] flex-col overflow-y-auto">
            {binnedShots.map((shot) => (
              <li
                key={shot.id}
                data-testid="bin-row"
                data-shot-id={shot.id}
                className="flex items-center gap-[10px] border-b border-border-subtle p-[9px_14px] last:border-b-0"
              >
                <span className="flex min-w-0 flex-1 flex-col gap-[2px]">
                  <span className="overflow-hidden text-ellipsis whitespace-nowrap text-small text-text-primary">
                    Shot {shot.order_index + 1} · {shotName(shot)}
                  </span>
                  <span className="text-meta text-text-tertiary">
                    {formatSeconds(filmDuration(shot))} · removed in Retime
                    {shot.binned_at ? `, ${formatClockTime(shot.binned_at)}` : ''}
                  </span>
                </span>
                <button
                  type="button"
                  data-testid="bin-restore"
                  disabled={readOnly}
                  onClick={() => setBinned(shot.id, false)}
                  className="flex h-[26px] flex-none cursor-pointer items-center gap-[6px] rounded-control border border-border-strong px-[9px] text-small text-text-primary hover:bg-bg-inset disabled:cursor-not-allowed disabled:opacity-60"
                >
                  Restore
                  <span className="font-mono text-mono text-text-tertiary">free</span>
                </button>
              </li>
            ))}
          </ul>
          <p className="border-t border-border-subtle p-[10px_14px] text-meta leading-[1.45] text-text-tertiary">
            Remove and Delete are the same act with two names — both land here, both keep the frame, neither spends
            anything. Restore returns a shot to the position it was removed from, not to the end.
          </p>
        </div>
      )}
    </div>
  )
}
