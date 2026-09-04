import { Spinner } from '@/components/spinner'
import type { CameraDerivationStatusValue } from './use-camera-derivation'
import { RevertIcon } from './camera-origin-fields'

const EXPLAINER = 'AI picks a camera, unless your description names one or you pick one yourself.'

function FailedDot() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true" className="flex-none">
      <circle cx="6" cy="6" r="5" stroke="currentColor" strokeWidth="1.2" />
      <path d="M6 3.4v3.1" stroke="currentColor" strokeWidth="1.3" />
      <circle cx="6" cy="8.6" r="0.75" fill="currentColor" />
    </svg>
  )
}

function joinWithAnd(items: string[]) {
  if (items.length === 0) return ''
  if (items.length === 1) return items[0]
  if (items.length === 2) return `${items[0]} and ${items[1]}`
  return `${items.slice(0, -1).join(', ')}, and ${items[items.length - 1]}`
}

// Deliberately separate from SaveStatusIndicator, not a fourth key folded into
// shot-card.tsx's fieldStatus/rollupStatus map: the visual_description field can save
// successfully even when the re-derivation it triggered afterward fails, so the two
// statuses must stay visually distinguishable rather than sharing one "didn't save"
// language that would misattribute the failure to the wrong action.
//
// This is the shared "note lane" below the three camera fields (canvas: "Camera fields ·
// three origins" close-up) - it states the static explainer at rest and on settle (the
// per-field "· was X" note carries the settle-specific detail), names exactly which
// fields are being rechecked while running, and states a failed recheck calmly (the
// stored values are untouched, unlike a failed save).
export function CameraDerivationStatus({
  status,
  pendingFieldLabels,
  heldFieldLabels,
  onRetry,
  showResetAll,
  onResetAll,
}: {
  status: CameraDerivationStatusValue
  pendingFieldLabels: string[]
  heldFieldLabels: string[]
  onRetry: () => void
  showResetAll: boolean
  onResetAll: () => void
}) {
  if (status === 'running') {
    const held = heldFieldLabels.length > 0 ? ` ${joinWithAnd(heldFieldLabels)} ${heldFieldLabels.length === 1 ? 'is' : 'are'} yours, so it stays.` : ''
    return (
      <span className="flex items-start gap-[5px] text-meta text-text-tertiary">
        <Spinner className="mt-[3px] h-[11px] w-[11px]" thickness={1.3} />
        Rechecking {joinWithAnd(pendingFieldLabels)} against your new description.{held}
      </span>
    )
  }

  if (status === 'failed') {
    return (
      <span className="flex items-start gap-[5px] text-meta text-status-failed-fg">
        <FailedDot />
        Couldn&rsquo;t reread the description for camera work. These values are the last ones stored, unchanged.{' '}
        <button type="button" onClick={onRetry} className="cursor-pointer underline hover:text-status-failed-fg">
          Try again
        </button>
      </span>
    )
  }

  return (
    <div className="flex items-start justify-between gap-rc-sm">
      <span className="text-meta text-text-tertiary">{EXPLAINER}</span>
      {showResetAll && (
        <button
          type="button"
          onClick={onResetAll}
          className="flex flex-none cursor-pointer items-center gap-[5px] text-meta text-accent hover:underline"
        >
          <RevertIcon />
          Reset all to auto
        </button>
      )}
    </div>
  )
}
