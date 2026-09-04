import { Spinner } from '@/components/spinner'
import type { FieldSaveStatus } from './use-field-save'

function FailedDot() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true" className="flex-none">
      <circle cx="6" cy="6" r="5" stroke="currentColor" strokeWidth="1.2" />
      <path d="M6 3.4v3.1" stroke="currentColor" strokeWidth="1.3" />
      <circle cx="6" cy="8.6" r="0.75" fill="currentColor" />
    </svg>
  )
}

function SavedCheck() {
  return (
    <svg width="10" height="8" viewBox="0 0 10 8" fill="none" aria-hidden="true" className="flex-none">
      <path d="M1 4.2 3.6 6.8 9 1.2" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

// Per-field status slot - saving/saved/failed, matching the canvas's "Save status · two
// tiers" close-up. "Saved" is transient (see use-field-save.ts's 2s decay); "idle"
// renders nothing at all, exactly as the canvas shows "no status" at rest. This lives in
// a fixed-height slot at every call site so a status change never reflows sibling
// content.
export function SaveStatusIndicator({
  status,
  label,
  onRetry,
  retryLabel = 'Retry',
}: {
  status: FieldSaveStatus
  label: string
  onRetry?: () => void
  retryLabel?: string
}) {
  if (status === 'idle') return null

  if (status === 'saving') {
    return (
      <span className="flex items-center gap-[5px] text-meta text-text-tertiary">
        <Spinner className="h-[11px] w-[11px]" thickness={1.3} />
        Saving…
      </span>
    )
  }

  if (status === 'saved') {
    return (
      <span className="flex items-center gap-[5px] text-meta text-text-tertiary">
        <SavedCheck />
        Saved
      </span>
    )
  }

  return (
    <span className="flex items-center gap-[5px] text-meta font-medium text-status-failed-fg">
      <FailedDot />
      {label}
      {onRetry && (
        <button type="button" onClick={onRetry} className="cursor-pointer underline hover:text-status-failed-fg">
          {retryLabel}
        </button>
      )}
    </span>
  )
}
