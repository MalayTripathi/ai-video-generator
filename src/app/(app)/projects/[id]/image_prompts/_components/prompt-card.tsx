'use client'

import { memo } from 'react'
import { PLATE_SIZE } from './plate-size'
import { useImagePrompts } from './image-prompts-context'
import { isEdited, isStale, isUngenerated } from './derive-image-prompts-phase'
import { useFieldSave } from '../../workbench/_components/use-field-save'
import { SaveStatusIndicator } from '../../workbench/_components/save-status-indicator'
import { PromptEditor } from './prompt-editor'
import { PromptReferences } from './prompt-references'
import { RegenerateButton } from './regenerate-button'
import type { PromptShot } from './types'

function CheckIcon() {
  return (
    <svg width="10" height="8" viewBox="0 0 10 8" fill="none" aria-hidden="true">
      <path d="M1 4.2 3.5 6.7 9 1.2" stroke="currentColor" strokeWidth="1.4" />
    </svg>
  )
}

export const PromptCard = memo(function PromptCard({ shot }: { shot: PromptShot }) {
  const {
    aspectRatio,
    readOnly,
    busyIds,
    regenerateLocked,
    checking,
    externalGenerating,
    outcome,
    costFor,
    regenerateOne,
  } = useImagePrompts()

  const save = useFieldSave()
  const busy = busyIds.has(shot.id)
  const ungenerated = isUngenerated(shot)
  const stale = isStale(shot)
  const edited = isEdited(shot)
  const updated = outcome?.kind === 'partial' && outcome.updatedIds.includes(shot.id)
  const kept = outcome?.kind === 'partial' && outcome.keptIds.includes(shot.id)
  const plate = PLATE_SIZE[aspectRatio]

  const borderClass = busy ? 'border-status-active-line' : kept ? 'border-status-failed-line' : 'border-border-subtle'
  const disabledReason = externalGenerating
    ? 'Prompts are being written in another window'
    : busyIds.size > 0
      ? 'Wait for the prompt being written to finish'
      : checking
        ? 'Checking your credit balance'
        : null

  return (
    <div
      aria-busy={busy}
      className={`grid flex-none grid-cols-[auto_1fr] gap-rc-sm rounded-frame border bg-bg-canvas p-[14px_16px] ${borderClass}`}
    >
      <div
        className="flex items-center justify-center rounded-control border border-border-subtle bg-bg-inset font-mono text-mono text-text-quiet"
        style={{ width: plate.w, height: plate.h }}
      >
        {aspectRatio}
      </div>

      <div className={`flex min-w-0 flex-col gap-[9px] ${busy ? 'opacity-[0.72]' : ''}`}>
        <div className="flex min-w-0 items-center gap-[9px]">
          <span className="flex-none text-ui font-medium tracking-micro text-text-primary">
            Shot {shot.order_index + 1}
          </span>
          {stale && (
            <span className="flex-none rounded-badge border border-status-stale-line bg-status-stale-bg px-[7px] py-[2px] text-chip font-medium text-status-stale-fg">
              Stale
            </span>
          )}
          {edited && (
            <span className="flex-none rounded-badge bg-status-edited-bg px-2 py-[3px] text-chip font-medium text-status-edited-fg">
              Edited by you
            </span>
          )}
          {updated && (
            <span className="flex flex-none items-center gap-[5px] text-meta text-status-done-fg">
              <CheckIcon />
              Updated
            </span>
          )}
          {kept && (
            <span className="flex-none rounded-badge bg-status-failed-bg px-2 py-[3px] text-chip font-medium text-status-failed-fg">
              Kept previous
            </span>
          )}
          {/* Save status sits with the badges, in flow, so the Regenerate overlay that
              expands over the spacer to its right can never cover it. */}
          <SaveStatusIndicator status={save.status} label="Prompt didn't save" onRetry={save.retry} />
          <span className="flex-1" />
          {busy ? (
            <span className="flex h-[30px] flex-none cursor-default items-center gap-[7px] rounded-control border border-border-subtle px-rc-sm text-small text-text-tertiary">
              <span className="h-[5px] w-[5px] rounded-full bg-status-active-fg" aria-hidden />
              {ungenerated ? 'Writing…' : 'Regenerating…'}
            </span>
          ) : (
            !readOnly && (
              <RegenerateButton
                variant={ungenerated ? 'generate' : stale ? 'stale' : 'quiet'}
                credits={costFor(1)}
                disabled={regenerateLocked}
                disabledReason={disabledReason}
                onClick={() => regenerateOne(shot.id)}
              />
            )
          )}
        </div>

        {busy ? (
          <div className="flex flex-col gap-[9px] rounded-control border border-status-active-line bg-status-active-bg p-[11px_12px]">
            <span className="text-small font-medium text-banner-active-title">
              {ungenerated ? 'Writing a prompt from the current shot' : 'Writing a new prompt from the current shot'}
            </span>
            <div className="h-[3px] rounded-[2px] bg-status-active-line">
              <span className="block h-[3px] w-2/5 animate-pulse rounded-[2px] bg-status-active-fg" />
            </div>
            {!ungenerated && (
              <span className="text-meta text-banner-active-body">
                Previous prompt stays in place until the new one lands.
              </span>
            )}
          </div>
        ) : ungenerated ? (
          <div className="flex min-h-[58px] items-center rounded-control border border-dashed border-border-strong px-rc-sm py-[10px] text-small text-text-tertiary">
            No prompt yet
          </div>
        ) : (
          <div className="flex flex-col gap-[5px]">
            <PromptEditor shotId={shot.id} value={shot.image_prompt ?? ''} readOnly={readOnly} run={save.run} />
            {save.status === 'failed' && save.error && (
              <span className="text-meta text-status-failed-fg">{save.error}</span>
            )}
          </div>
        )}

        <PromptReferences shotId={shot.id} elements={shot.elements} readOnly={readOnly} />
      </div>
    </div>
  )
})
