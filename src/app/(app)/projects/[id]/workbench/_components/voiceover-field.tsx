'use client'

import { memo, useEffect, useState } from 'react'
import { updateShotVoiceOver } from '../actions'
import { SaveStatusIndicator } from './save-status-indicator'
import { useFieldSave, type FieldSaveStatus } from './use-field-save'

// Field-level textarea styling: a visible border/fill at rest (canvas: "Text fields"
// close-up) so the field reads as editable before it's ever touched, with an accent
// focus ring layered on top rather than replacing the resting chrome.
const fieldTextareaClassName =
  'w-full min-h-[52px] resize-none rounded-control border border-border-strong bg-bg-canvas px-rc-sm py-[10px] text-small leading-[1.5] text-text-primary outline-none focus-visible:border-accent focus-visible:bg-bg-surface focus-visible:shadow-focus-halo'

export const VoiceoverField = memo(function VoiceoverField({
  shotId,
  voiceOver,
  onSaved,
  onStatusChange,
}: {
  shotId: string
  voiceOver: string
  onSaved: (patch: { voice_over: string }) => void
  onStatusChange: (status: FieldSaveStatus, retry: () => void) => void
}) {
  const [value, setValue] = useState(voiceOver)
  const [persisted, setPersisted] = useState(voiceOver)
  const { status, run, retry } = useFieldSave()

  useEffect(() => {
    onStatusChange(status, retry)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status])

  function handleBlur() {
    const trimmed = value.trim()
    if (trimmed === persisted) return
    void run(async () => {
      const result = await updateShotVoiceOver(shotId, trimmed)
      if (result.success) {
        setPersisted(trimmed)
        setValue(trimmed)
        onSaved({ voice_over: trimmed })
      }
      return result
    })
  }

  return (
    <div className="flex flex-col gap-rc-2xs">
      <div className="flex min-h-4 items-center justify-between gap-rc-xs">
        <span className="text-label font-medium uppercase leading-4 tracking-label text-text-tertiary">
          Voiceover — the narrator, over the whole film
        </span>
        <SaveStatusIndicator status={status} label="Voiceover didn't save" onRetry={retry} />
      </div>
      <textarea
        aria-label="Voiceover"
        value={value}
        onChange={(event) => setValue(event.target.value)}
        onBlur={handleBlur}
        rows={2}
        className={fieldTextareaClassName}
      />
      {status === 'failed' && (
        <span className="text-meta text-text-tertiary">This edit is still on this screen only. Retry to store it.</span>
      )}
    </div>
  )
})
