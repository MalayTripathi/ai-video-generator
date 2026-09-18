'use client'

import { useLayoutEffect, useRef, useState, type CSSProperties } from 'react'
import { formatCredits } from '@/lib/format-credits'

function RegenerateIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true" className="flex-none">
      <path d="M10.5 6a4.5 4.5 0 1 1-1.4-3.25M10.6 1.2v2.4H8.2" stroke="currentColor" strokeWidth="1.2" />
    </svg>
  )
}

// Per-card Regenerate keeps its outline in every row but carries weight only where it is
// needed: a stale row shows the full label and cost in the stale colour family (the badge
// and the action that clears it read as one thing); any other row collapses to the icon
// and expands in place to label + cost on hover or focus. An ungenerated shot has nothing
// to regenerate, so its action is "Generate" and always shows its label.
//
// The collapsed control is an overlay in a fixed 30px slot, anchored to the slot's right
// edge, so expanding leftward over the row's empty spacer can never move the card or any
// neighbour. The label is revealed with a max-width transition to its *measured* pixel
// width - a transition to `auto` (or a width change on an auto-sized box) does not animate.
export function RegenerateButton({
  variant,
  credits,
  disabled,
  disabledReason,
  onClick,
}: {
  variant: 'stale' | 'quiet' | 'generate'
  credits: number
  disabled: boolean
  disabledReason: string | null
  onClick: () => void
}) {
  const label = variant === 'generate' ? 'Generate' : 'Regenerate'
  const cost = `${formatCredits(credits)} cr`
  const accessibleName = `${label} · ${formatCredits(credits)} credits`
  const revealRef = useRef<HTMLSpanElement>(null)
  const [revealWidth, setRevealWidth] = useState<number | null>(null)

  useLayoutEffect(() => {
    if (revealRef.current) setRevealWidth(revealRef.current.offsetWidth)
  }, [label, cost])

  const focusRing =
    'outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent'
  const base = `flex h-[30px] cursor-pointer items-center rounded-control border bg-bg-surface text-small disabled:cursor-not-allowed disabled:opacity-50 ${focusRing}`

  if (variant !== 'quiet') {
    const tone =
      variant === 'stale'
        ? 'border-status-stale-line text-status-stale-fg hover:bg-status-stale-bg'
        : 'border-border-strong text-text-secondary hover:border-border-strong-hover hover:bg-bg-inset hover:text-text-primary'
    return (
      <button
        type="button"
        title={disabled && disabledReason ? disabledReason : undefined}
        aria-label={accessibleName}
        disabled={disabled}
        onClick={onClick}
        className={`${base} flex-none gap-[7px] px-[12px] ${tone}`}
      >
        <RegenerateIcon />
        <span>{label}</span>
        <span className={`font-mono text-mono ${variant === 'stale' ? 'text-status-stale-fg' : 'text-text-tertiary'}`}>
          {cost}
        </span>
      </button>
    )
  }

  return (
    <span className="relative block h-[30px] w-[30px] flex-none">
      <button
        type="button"
        title={disabled && disabledReason ? disabledReason : undefined}
        aria-label={accessibleName}
        disabled={disabled}
        onClick={onClick}
        className={`${base} group/regen absolute right-0 top-0 z-10 border-border-strong px-[8px] text-text-secondary hover:border-border-strong-hover hover:bg-bg-inset hover:text-text-primary`}
      >
        <RegenerateIcon />
        <span
          aria-hidden
          className="block max-w-0 overflow-hidden whitespace-nowrap [transition:max-width_var(--motion)] group-hover/regen:max-w-[var(--reveal-width,140px)] group-focus-visible/regen:max-w-[var(--reveal-width,140px)] motion-reduce:transition-none"
          style={revealWidth === null ? undefined : ({ '--reveal-width': `${revealWidth}px` } as CSSProperties)}
        >
          <span ref={revealRef} className="flex w-max items-center gap-[7px] pl-[7px]">
            <span>{label}</span>
            <span className="font-mono text-mono text-text-tertiary">{cost}</span>
          </span>
        </span>
      </button>
    </span>
  )
}
