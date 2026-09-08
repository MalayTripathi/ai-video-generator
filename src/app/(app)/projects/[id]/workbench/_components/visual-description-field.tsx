'use client'

import { memo, useEffect, useState } from 'react'
import { updateShotVisualDescription } from '../actions'
import { SaveStatusIndicator } from './save-status-indicator'
import { useFieldSave, type FieldSaveStatus } from './use-field-save'
import { useExternalResync } from './use-external-resync'
import { useShots } from './shots-context'
import { visualDescriptionIsValid, EMPTY_VISUAL_DESCRIPTION_MESSAGE } from '@/lib/shot-visual-description'

// Visible border/fill at rest, matching the voiceover field's treatment (canvas: "Text
// fields" close-up) - only the type-scale role (text-small/secondary vs. text-body/primary)
// distinguishes this field from voiceover, not whether it has a boundary. Border color is
// applied separately (never concatenated with this string) so the invalid-state border
// fully replaces the resting one instead of two border-color utilities competing.
const fieldTextareaBaseClassName =
  'w-full min-h-[52px] resize-none rounded-control border bg-bg-canvas px-rc-sm py-[10px] text-small leading-[1.5] text-text-primary outline-none focus-visible:border-accent focus-visible:bg-bg-surface focus-visible:shadow-focus-halo'

export const VisualDescriptionField = memo(function VisualDescriptionField({
  shotId,
  shotKey,
  visualDescription,
  readOnly,
  onSaved,
  onStatusChange,
}: {
  shotId: string
  shotKey: string
  visualDescription: string | null
  readOnly: boolean
  onSaved: (patch: { visual_description: string }) => void
  onStatusChange: (status: FieldSaveStatus, retry: () => void) => void
}) {
  const { touchedShotKeys, refreshPending, consumeTouchedShot } = useShots()
  const [value, setValue] = useState(visualDescription ?? '')
  const [persisted, setPersisted] = useState(visualDescription ?? '')
  // Starts pre-touched when the persisted value already fails validation (e.g. a shot
  // arriving from write_shots with an empty description) - see this file's comment on
  // showValidationError. Without this, the error stays invisible until the user happens
  // to click into and out of this exact field, even though runCameraDerivation is
  // already silently refusing to run against the same empty value.
  const [touched, setTouched] = useState(() => !visualDescriptionIsValid((visualDescription ?? '').trim()))
  const { status, run, retry } = useFieldSave()

  useEffect(() => {
    onStatusChange(status, retry)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status])

  const { focused, setFocused } = useExternalResync(
    visualDescription ?? '',
    touchedShotKeys.has(shotKey),
    refreshPending,
    (fresh) => {
      setValue(fresh)
      setPersisted(fresh)
    },
    () => consumeTouchedShot(shotKey)
  )

  // Same derived-validity shape as voiceover-field.tsx - see that file's comment. Never
  // routed through useFieldSave's status, so nothing to clear explicitly.
  const showValidationError = touched && !focused && !visualDescriptionIsValid(value.trim())

  function handleBlur() {
    setFocused(false)
    setTouched(true)
    const trimmed = value.trim()
    if (!visualDescriptionIsValid(trimmed)) return
    if (trimmed === persisted) return
    void run(async () => {
      const result = await updateShotVisualDescription(shotId, trimmed)
      if (result.success) {
        setPersisted(trimmed)
        setValue(trimmed)
        onSaved({ visual_description: trimmed })
      }
      return result
    })
  }

  if (readOnly) {
    return (
      <div className="flex flex-col gap-rc-2xs">
        <span className="text-label font-medium uppercase leading-4 tracking-label text-text-tertiary">Visual</span>
        <div className="rounded-control bg-bg-inset px-rc-sm py-[10px] text-small leading-[1.5] text-text-primary">
          {visualDescription || '—'}
        </div>
      </div>
    )
  }

  const textareaClassName = `${fieldTextareaBaseClassName} ${showValidationError ? 'border-status-failed-fg' : 'border-border-strong'}`

  return (
    <div className="flex flex-col gap-rc-2xs">
      <div className="flex min-h-4 items-center justify-between gap-rc-xs">
        <span className="text-label font-medium uppercase leading-4 tracking-label text-text-tertiary">Visual</span>
        <SaveStatusIndicator status={status} label="Visual didn't save" onRetry={retry} />
      </div>
      <textarea
        aria-label="Visual description"
        value={value}
        onChange={(event) => setValue(event.target.value)}
        onFocus={() => setFocused(true)}
        onBlur={handleBlur}
        rows={2}
        className={textareaClassName}
      />
      {status === 'failed' && !showValidationError && (
        <span className="text-meta text-text-tertiary">This edit is still on this screen only. Retry to store it.</span>
      )}
      {showValidationError && <span className="text-meta text-status-failed-fg">{EMPTY_VISUAL_DESCRIPTION_MESSAGE}</span>}
    </div>
  )
})
