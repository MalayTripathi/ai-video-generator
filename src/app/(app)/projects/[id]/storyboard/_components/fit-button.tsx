'use client'

import { useStoryboard } from './storyboard-context'

function FitIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 12 12" fill="none" aria-hidden="true">
      <path d="M1 6h10M8.5 3.2 11.3 6 8.5 8.8M3.5 3.2.7 6l2.8 2.8" stroke="currentColor" strokeWidth="1.2" />
    </svg>
  )
}

// Fit to voiceover (canvas 15b header): sets every in-film shot's length from the read, so
// the picture follows the narration. Free. It exists once a voiceover does; while the read
// is stale, out of order or still being made it stays visible but unavailable, with the
// reason on hover and for assistive tech. `compact` collapses it to its icon.
export function FitButton({ compact }: { compact: boolean }) {
  const { voiceover, fitReason, fitToVoiceover, readOnly } = useStoryboard()
  if (!voiceover.current && voiceover.state !== 'generating') return null
  const unavailable = fitReason !== null || readOnly
  const label = fitReason ? `Fit to voiceover — ${fitReason}` : 'Fit to voiceover · free'
  return (
    <button
      type="button"
      data-testid="fit-to-voiceover"
      aria-label={label}
      title={compact || fitReason ? label : undefined}
      aria-disabled={unavailable}
      onClick={() => {
        if (!unavailable) fitToVoiceover()
      }}
      className={`flex h-[28px] flex-none items-center gap-[7px] whitespace-nowrap rounded-control border border-border-strong text-small text-text-primary ${
        compact ? 'w-[28px] justify-center' : 'px-[11px]'
      } ${unavailable ? 'cursor-not-allowed opacity-60' : 'cursor-pointer hover:border-border-strong-hover hover:bg-bg-inset'}`}
    >
      <FitIcon />
      {!compact && 'Fit to voiceover'}
    </button>
  )
}
