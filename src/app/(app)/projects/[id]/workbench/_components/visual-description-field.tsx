'use client'

import { memo, useEffect, useState } from 'react'
import { updateShotVisualDescription } from '../actions'
import { SaveStatusIndicator } from './save-status-indicator'
import { useFieldSave, type FieldSaveStatus } from './use-field-save'

// Visible border/fill at rest, matching the voiceover field's treatment (canvas: "Text
// fields" close-up) - only the type-scale role (text-small/secondary vs. text-body/primary)
// distinguishes this field from voiceover, not whether it has a boundary.
const fieldTextareaClassName =
  'w-full min-h-[52px] resize-none rounded-control border border-border-strong bg-bg-canvas px-rc-sm py-[10px] text-small leading-[1.5] text-text-primary outline-none focus-visible:border-accent focus-visible:bg-bg-surface focus-visible:shadow-focus-halo'

export const VisualDescriptionField = memo(function VisualDescriptionField({
  shotId,
  visualDescription,
  onSaved,
  onStatusChange,
}: {
  shotId: string
  visualDescription: string | null
  onSaved: (patch: { visual_description: string }) => void
  onStatusChange: (status: FieldSaveStatus, retry: () => void) => void
}) {
  const [value, setValue] = useState(visualDescription ?? '')
  const [persisted, setPersisted] = useState(visualDescription ?? '')
  const { status, run, retry } = useFieldSave()

  useEffect(() => {
    onStatusChange(status, retry)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status])

  function handleBlur() {
    const trimmed = value.trim()
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
        onBlur={handleBlur}
        rows={2}
        className={fieldTextareaClassName}
      />
    </div>
  )
})
