'use client'

import { Spinner } from '@/components/spinner'
import { LockIcon } from './lock-icon'
import { RetryConfirmModal } from './retry-confirm-modal'
import { ShotCard } from './shot-card'
import { useShots } from './shots-context'
import type { DisplayShot } from './types'
import { canGenerateRemaining, shotRunProgressLine, type ShotRunView } from './shot-run-view'
import { formatCredits } from '@/lib/format-credits'

function SkeletonBar({ width, height }: { width: string; height: string }) {
  return <span className="rounded-[3px] bg-skeleton-base" style={{ width, height }} />
}

function GeneratingSkeleton({ run }: { run: ShotRunView }) {
  return (
    <div className="flex flex-col gap-rc-sm">
      <div className="flex items-center gap-rc-xs text-small text-text-secondary">
        <Spinner />
        {shotRunProgressLine(run)}
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

function GenerationFailedBanner({ onRetry, body }: { onRetry: () => void; body: string }) {
  return (
    <div className="flex items-center justify-between gap-rc-md rounded-control border border-status-failed-line bg-status-failed-bg p-[14px_16px]">
      <div className="flex flex-col gap-[3px]">
        <span className="text-control font-medium text-banner-failed-title">Couldn&rsquo;t build the shot list</span>
        <span className="text-small leading-[1.5] text-banner-failed-body">
          {body}
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

function GenerationPartialBanner({
  onRetry,
  onRemaining,
  stoppedForCredits,
  refused,
}: {
  onRetry: () => void
  onRemaining: (() => void) | null
  stoppedForCredits: boolean
  refused: boolean
}) {
  return (
    <div className="flex items-center justify-between gap-rc-md rounded-control border border-status-active-bg-hover bg-status-active-bg p-[14px_16px]">
      <div className="flex flex-col gap-[3px]">
        <span className="text-control font-medium text-banner-active-title">
          {stoppedForCredits ? 'Ran out of credits' : refused ? 'Part of the brief was declined' : 'Generation was cut short'}
        </span>
        <span className="text-small leading-[1.5] text-banner-active-body">
          {refused
            ? "The AI's safety checks declined some scenes, and nothing was charged for them. The shots below are saved — try rewording the brief."
            : onRemaining
            ? 'Some scenes were not written. The shots below are saved.'
            : 'The shots below may be incomplete.'}
        </span>
      </div>
      <div className="flex flex-none gap-rc-xs">
        {onRemaining && (
          <button
            type="button"
            onClick={onRemaining}
            className="flex h-8 cursor-pointer items-center rounded-control border border-accent bg-bg-surface px-rc-sm text-small font-medium text-accent hover:bg-accent-wash"
          >
            Generate remaining shots
          </button>
        )}
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
    const showHeading = !previous || previous.shot.scene_title !== shot.scene_title
    rows.push({ shot, showHeading })
    return rows
  }, [])
}

function ShotList({ shots }: { shots: DisplayShot[] }) {
  return (
    <div className="flex flex-col gap-rc-sm">
      {withHeadings(shots).map(({ shot, showHeading }) => (
        <div key={shot.id} className="flex flex-col gap-rc-sm">
          {showHeading && shot.scene_title && (
            <div className="text-label uppercase tracking-label text-text-tertiary">{shot.scene_title}</div>
          )}
          <ShotCard shot={shot} />
        </div>
      ))}
    </div>
  )
}

// Stated once here, not repeated per card - the cards themselves carry the read-only
// meaning by shape (see shot-card.tsx).
function ReadOnlyBanner() {
  return (
    <div className="flex items-center gap-rc-xs border-b border-border-subtle pb-rc-sm">
      <span className="flex flex-none items-center gap-[5px] rounded-full bg-bg-inset px-[10px] py-[4px] text-chip text-text-secondary">
        <LockIcon />
        View only
      </span>
      <span className="text-small leading-[1.5] text-text-secondary">
        The storyboard is built from these shots.
      </span>
    </div>
  )
}

export function ShotsTab() {
  const {
    shots,
    phase,
    hasPendingPayload,
    shotListCredits,
    run,
    startError,
    confirmOpen,
    confirmMode,
    openRetryConfirm,
    openRemainingConfirm,
    closeRetryConfirm,
    confirmRetry,
    readOnly,
  } = useShots()

  const stoppedForCredits = run.stopReason === 'balance'
  const refused = run.stopReason === 'refused'
  const failedBody = stoppedForCredits
    ? "There weren't enough credits to write the shots. Nothing was charged."
    : refused
      ? "The AI's safety checks declined this brief. Your brief is saved — nothing was charged. Try rewording it."
      : 'The model returned nothing usable. Your brief is saved — nothing was charged.'

  const modal = (
    <RetryConfirmModal
      open={confirmOpen}
      mode={confirmMode}
      hasPendingPayload={hasPendingPayload}
      shotListCredits={shotListCredits}
      replacesExisting={phase === 'partial'}
      onConfirm={confirmRetry}
      onCancel={closeRetryConfirm}
    />
  )

  // A start refused for credits leaves the prior state untouched, with the reason.
  if (startError && (phase === 'trigger' || phase === 'failed'))
    return (
      <>
        {modal}
        <GenerationFailedBanner
          onRetry={openRetryConfirm}
          body={`Writing the shot list needs ${formatCredits(startError.requiredCredits)} credits and you have ${formatCredits(startError.balanceCredits)}. Nothing was charged.`}
        />
      </>
    )
  if (phase === 'generating' || phase === 'trigger') return <GeneratingSkeleton run={run} />
  if (phase === 'failed')
    return (
      <>
        {modal}
        <GenerationFailedBanner onRetry={openRetryConfirm} body={failedBody} />
      </>
    )
  if (phase === 'partial') {
    return (
      <div className="flex flex-col gap-rc-sm">
        {modal}
        {startError && (
          <div className="text-small text-status-active-fg">
            Writing more shots needs {formatCredits(startError.requiredCredits)} credits and you have{' '}
            {formatCredits(startError.balanceCredits)}. Nothing was charged.
          </div>
        )}
        <GenerationPartialBanner
          onRetry={openRetryConfirm}
          onRemaining={canGenerateRemaining(run) ? openRemainingConfirm : null}
          stoppedForCredits={stoppedForCredits}
          refused={refused}
        />
        <ShotList shots={shots} />
      </div>
    )
  }
  if (shots.length === 0)
    return (
      <>
        {modal}
        <NoShotsEmptyState onRebuild={openRetryConfirm} />
      </>
    )
  // A list whose scene plan still has scenes unwritten (a run from before a run could only
  // end 'completed' with every scene written) keeps "Generate remaining shots" in reach.
  const remaining = !readOnly && canGenerateRemaining(run)
  return (
    <div className="flex flex-col gap-rc-sm">
      {remaining && modal}
      {readOnly && <ReadOnlyBanner />}
      {remaining && (
        <GenerationPartialBanner
          onRetry={openRetryConfirm}
          onRemaining={openRemainingConfirm}
          stoppedForCredits={stoppedForCredits}
          refused={refused}
        />
      )}
      <ShotList shots={shots} />
    </div>
  )
}
