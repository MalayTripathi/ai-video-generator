'use client'

import { useStoryboard } from './storyboard-context'

// Canvas 15c (c): the picture order no longer matches the script the voiceover was read
// from. Amber, one of the three warnings. Shown only once a voiceover exists; Fit to
// voiceover is unavailable while the order differs, and Restore script order is free.
export function OrderDiffersBanner() {
  const { restoreScriptOrder, readOnly } = useStoryboard()
  return (
    <div
      role="alert"
      data-testid="order-differs-banner"
      className="flex items-center gap-rc-sm rounded-control border-l-2 border-status-active-fg bg-status-active-bg p-[13px_15px]"
    >
      <div className="flex flex-1 flex-col gap-[4px] pl-rc-2xs">
        <span className="text-ui font-medium text-banner-active-title">Picture order differs from the voiceover</span>
        <span className="text-small leading-[1.5] text-banner-active-body">
          Shots were reordered after the voiceover was generated, so the narration no longer describes what is on screen.
          Timings are untouched.
        </span>
      </div>
      <button
        type="button"
        disabled
        className="flex h-8 flex-none cursor-not-allowed items-center whitespace-nowrap rounded-control border border-border-strong px-rc-sm text-small text-text-secondary opacity-60"
      >
        Fit to voiceover
      </button>
      <button
        type="button"
        data-testid="restore-script-order"
        disabled={readOnly}
        onClick={restoreScriptOrder}
        className="flex h-8 flex-none cursor-pointer items-center gap-rc-xs whitespace-nowrap rounded-control border border-accent px-rc-sm text-small font-medium text-accent hover:bg-status-active-bg-hover disabled:cursor-not-allowed disabled:opacity-60"
      >
        Restore script order
        <span className="font-mono text-mono font-normal">free</span>
      </button>
    </div>
  )
}
