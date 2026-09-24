'use client'

import { EditedChip } from '@/components/edited-chip'
import { InsufficientCreditsBanner } from '@/components/insufficient-credits-banner'
import { PromptEditor } from '@/components/prompt-editor'
import { STORYBOARD_IMAGE_SIZES } from '@/lib/config/storyboard'
import { formatClockTime } from '@/lib/format-clock-time'
import { formatCredits } from '@/lib/format-credits'
import { etaFor, isInFlight } from '@/lib/storyboard/timeline'
import { imagePrice, promptPrice, useStoryboard } from './storyboard-context'
import { formatSeconds } from './shot-block'
import { useNow } from './use-now'
import { hasPrompt, isEdited } from '../../image_prompts/_components/derive-image-prompts-phase'
import { SaveStatusIndicator } from '../../workbench/_components/save-status-indicator'
import { useFieldSave } from '../../workbench/_components/use-field-save'

const FRAME_MAX_HEIGHT_PX = 249

function RegenerateIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 12 12" fill="none" aria-hidden="true">
      <path d="M10.5 6a4.5 4.5 0 1 1-1.4-3.25M10.6 1.2v2.4H8.2" stroke="currentColor" strokeWidth="1.2" />
    </svg>
  )
}

// static until motion - the film-wide default, read-only here (canvas 15e/15g)
function MotionRow() {
  return (
    <div className="flex items-baseline gap-[10px]">
      <span className="w-[64px] flex-none text-small text-text-tertiary">Motion</span>
      <span className="flex-1 text-small font-medium">Alternate</span>
      <span className="text-meta text-text-quiet">set in Motion &amp; transitions</span>
    </div>
  )
}

// The inspect panel (canvas 15e). It takes the agent's column - the main column never
// resizes - and holds the selected shot: its full image, image actions, the editable
// prompt (saved on blur, exactly as on Step 3), and the two properties other modes own.
export function InspectPanel() {
  const { selectedShotId } = useStoryboard()
  // Keyed per shot: its save status and draft belong to that shot's field alone.
  return <InspectBody key={selectedShotId ?? 'none'} />
}

function InspectBody() {
  const {
    shots,
    statusFor,
    selectedShotId,
    select,
    aspectRatio,
    readOnly,
    busyShotIds,
    promptBusy,
    actionError,
    generate,
    regeneratePrompt,
    onPromptSaved,
  } = useStoryboard()

  const shot = shots.find((s) => s.id === selectedShotId)
  const now = useNow(shot !== undefined && isInFlight(statusFor(shot.id).state))
  const save = useFieldSave()
  if (!shot) return null

  const status = statusFor(shot.id)
  const stale = status.state === 'stale'
  const inFlight = isInFlight(status.state)
  const hasImage = status.imageUrl !== null
  const [w, h] = STORYBOARD_IMAGE_SIZES[aspectRatio].split('x').map(Number)
  const dims = `${w} × ${h}`
  const sub = status.drawnAt ? `Drawn ${formatClockTime(status.drawnAt)} · ${dims}` : hasImage ? dims : 'Not drawn yet'
  const imageCredits = imagePrice(1)
  const promptCredits = promptPrice()
  const imageDisabled = readOnly || inFlight || busyShotIds.has(shot.id)
  const imageLabel = status.imagePath ? 'Regenerate image' : 'Generate image'
  const error = actionError?.source === 'inspect' ? actionError : null
  const eta = inFlight ? etaFor(status.startedAt, status.queuedAt, now) : null

  return (
    <aside
      data-testid="inspect-panel"
      aria-label={`Shot ${shot.order_index + 1}`}
      className="flex w-[330px] min-w-[280px] flex-none flex-col border-r border-border-subtle bg-bg-surface"
    >
      <div className="flex flex-none flex-col gap-[8px] border-b border-border-subtle px-rc-md pb-[12px] pt-[13px]">
        <button
          type="button"
          onClick={() => select(null)}
          className="flex cursor-pointer items-center gap-[6px] self-start text-small text-text-tertiary hover:text-text-primary"
        >
          <svg width="11" height="9" viewBox="0 0 11 9" fill="none" aria-hidden="true">
            <path d="M10.25 4.5H1.75M4.75 1.25 1.5 4.5l3.25 3.25" stroke="currentColor" strokeWidth="1.3" />
          </svg>
          Back to agent
        </button>
        <div className="flex items-center gap-[9px]">
          <span className="flex-none text-section font-medium tracking-micro">Shot {shot.order_index + 1}</span>
          {stale && (
            <span
              data-testid="inspect-stale-chip"
              className="flex-none rounded-badge border border-status-stale-line bg-status-stale-bg px-[7px] py-[2px] text-chip font-medium uppercase tracking-label text-status-stale-fg"
            >
              Stale
            </span>
          )}
          {isEdited(shot) && <EditedChip />}
          <SaveStatusIndicator status={save.status} label="Prompt didn't save" onRetry={save.retry} />
          <span className="flex-1" />
          <button
            type="button"
            aria-label="Close"
            onClick={() => select(null)}
            className="flex h-[22px] w-[22px] flex-none cursor-pointer items-center justify-center rounded-badge text-text-tertiary hover:bg-bg-inset hover:text-text-primary"
          >
            <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden="true">
              <path d="M1 1l8 8M9 1l-8 8" stroke="currentColor" strokeWidth="1.3" />
            </svg>
          </button>
        </div>
        <span data-testid="inspect-sub" className="text-meta text-text-tertiary">
          {sub}
        </span>
      </div>

      <div className="flex flex-1 flex-col gap-[13px] overflow-y-auto p-rc-md">
        <div
          data-testid="inspect-frame"
          className={`self-center overflow-hidden rounded-control border ${
            stale ? 'border-status-stale-line' : 'border-border-subtle'
          } ${hasImage ? '' : 'flex items-center justify-center border-dashed bg-bg-well'}`}
          style={{ aspectRatio: `${w} / ${h}`, width: `min(100%, ${(FRAME_MAX_HEIGHT_PX * w) / h}px)` }}
        >
          {hasImage ? (
            // eslint-disable-next-line @next/next/no-img-element -- signed, short-lived storage URL
            <img src={status.imageUrl!} alt={`Shot ${shot.order_index + 1}`} className="block h-full w-full object-cover" />
          ) : eta ? (
            <span className="block h-[3px] w-[40%] overflow-hidden rounded-[2px] bg-sb-active-line">
              <span className="block h-[3px] rounded-[2px] bg-sb-active-fg" style={{ width: `${eta.pct}%` }} />
            </span>
          ) : (
            <span className="text-body text-text-quiet" aria-hidden>
              ?
            </span>
          )}
        </div>

        <button
          type="button"
          data-testid="inspect-regenerate-image"
          disabled={imageDisabled}
          onClick={() => void generate([shot.id], 'inspect')}
          className={`flex h-[32px] cursor-pointer items-center justify-center gap-[8px] rounded-control border bg-bg-canvas text-small font-medium hover:bg-bg-inset disabled:cursor-not-allowed disabled:opacity-60 ${
            stale ? 'border-status-stale-line text-status-stale-fg' : 'border-border-strong text-text-primary'
          }`}
        >
          <RegenerateIcon />
          {imageLabel}
          <span className={`font-mono text-mono font-normal ${stale ? 'text-status-stale-fg' : 'text-text-tertiary'}`}>
            {formatCredits(imageCredits)} cr
          </span>
        </button>

        <div className="flex flex-col gap-[7px]">
          <div className="flex items-center gap-[9px]">
            <span className="flex-1 text-label uppercase tracking-label text-text-tertiary">Image prompt</span>
            <button
              type="button"
              data-testid="inspect-regenerate-prompt"
              disabled={readOnly || promptBusy}
              onClick={() => regeneratePrompt(shot.id)}
              className="flex h-[26px] cursor-pointer items-center gap-[6px] whitespace-nowrap rounded-control border border-border-subtle px-[9px] text-small text-text-secondary hover:border-border-strong hover:bg-bg-inset hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-60"
            >
              {promptBusy ? 'Writing…' : 'Regenerate prompt'}
              <span className="font-mono text-mono text-text-tertiary">{formatCredits(promptCredits)} cr</span>
            </button>
          </div>
          <div data-testid="inspect-prompt">
            <PromptEditor
              shotId={shot.id}
              value={shot.image_prompt ?? ''}
              run={save.run}
              missing={!hasPrompt(shot)}
              onSaved={onPromptSaved}
              readOnly={readOnly}
            />
          </div>
          {save.status === 'failed' && save.error && (
            <span role="alert" className="text-meta text-status-failed-fg">
              {save.error}
            </span>
          )}
          <span
            data-testid="inspect-note"
            className={`text-meta leading-[1.45] ${stale ? 'text-status-stale-fg' : 'text-text-tertiary'}`}
          >
            {stale
              ? 'This frame was drawn from the previous prompt. Regenerating the image clears the badge.'
              : 'Editing marks this frame stale; it does not redraw it.'}
          </span>
        </div>

        {error?.kind === 'credits' && (
          <InsufficientCreditsBanner
            title={error.title}
            subject="This"
            requiredCredits={error.requiredCredits}
            balanceCredits={error.balanceCredits}
          />
        )}
        {error?.kind === 'error' && (
          <span role="alert" className="text-small text-status-failed-fg">
            {error.message}
          </span>
        )}

        <div className="flex flex-col gap-[6px] border-t border-border-subtle pt-[11px]">
          <div className="flex items-baseline gap-[10px]">
            <span className="w-[64px] flex-none text-small text-text-tertiary">Duration</span>
            <span data-testid="inspect-duration" className="flex-1 text-small font-medium">
              {formatSeconds(shot.duration_sec)}
            </span>
            <span className="text-meta text-text-quiet">set in Retime</span>
          </div>
          <MotionRow />
        </div>
      </div>
    </aside>
  )
}
