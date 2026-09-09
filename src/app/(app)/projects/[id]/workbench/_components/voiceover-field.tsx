'use client'

import { memo, useEffect, useState } from 'react'
import { updateShotVoiceOver } from '../actions'
import { SaveStatusIndicator } from './save-status-indicator'
import { useFieldSave, type FieldSaveStatus } from './use-field-save'
import { useExternalResync } from './use-external-resync'
import { useShots } from './shots-context'
import { voiceOverIsValid, EMPTY_VOICEOVER_MESSAGE } from '@/lib/shot-voiceover'

// Field-level textarea styling: a visible border/fill at rest (canvas: "Text fields"
// close-up) so the field reads as editable before it's ever touched, with an accent
// focus ring layered on top rather than replacing the resting chrome. Border color is
// applied separately (never concatenated with this string) so an invalid-state border
// fully replaces the resting one instead of two border-color utilities competing.
const fieldTextareaBaseClassName =
  'w-full min-h-[52px] resize-none rounded-control border bg-bg-canvas px-rc-sm py-[10px] text-small leading-[1.5] text-text-primary outline-none focus-visible:border-accent focus-visible:bg-bg-surface focus-visible:shadow-focus-halo'

export const VoiceoverField = memo(function VoiceoverField({
  shotId,
  shotKey,
  voiceOver,
  hasDialogue,
  readOnly,
  onSaved,
  onStatusChange,
}: {
  shotId: string
  shotKey: string
  voiceOver: string
  hasDialogue: boolean
  readOnly: boolean
  onSaved: (patch: { voice_over: string }) => void
  onStatusChange: (status: FieldSaveStatus, retry: () => void) => void
}) {
  const { touchedShotKeys, refreshPending, consumeTouchedShot } = useShots()
  const [value, setValue] = useState(voiceOver)
  const [persisted, setPersisted] = useState(voiceOver)
  // Starts pre-touched when the persisted value already fails validation (e.g. a shot
  // arriving from write_shots with dialogue-only narration - the system prompt permits
  // an empty voice_over exactly in that case). Without this, the error stays invisible
  // until the user happens to click into and out of this exact field.
  const [touched, setTouched] = useState(() => !voiceOverIsValid(voiceOver.trim(), hasDialogue))
  const { status, run, retry } = useFieldSave()

  useEffect(() => {
    onStatusChange(status, retry)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status])

  const { focused, setFocused } = useExternalResync(
    voiceOver,
    touchedShotKeys.has(shotKey),
    refreshPending,
    (fresh) => {
      setValue(fresh)
      setPersisted(fresh)
    },
    () => consumeTouchedShot(shotKey)
  )

  // Validity is derived fresh on every render from the current draft and the current
  // hasDialogue prop - never stored in state and never routed through useFieldSave's
  // status. That's what keeps it correct with no explicit "clear the error" step: pasting
  // the persisted value back, or a dialogue row landing elsewhere, both simply recompute
  // this to false on the next render, with nothing to forget to reset. `touched` only
  // gates the *first* appearance (canvas: nothing validates while typing, only on blur);
  // once true it stays true, and `!focused` hides the error again while actively editing.
  const showValidationError = touched && !focused && !voiceOverIsValid(value.trim(), hasDialogue)

  function handleBlur() {
    setFocused(false)
    setTouched(true)
    const trimmed = value.trim()

    // Never reaches the network for a value already known invalid (same shape as
    // dialogue-row.tsx's own empty-value guard) - and never touches save status either,
    // since this was never attempted as a save. showValidationError (above) is what
    // renders the error, independently of status.
    if (!voiceOverIsValid(trimmed, hasDialogue)) return

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

  if (readOnly) {
    return (
      <div className="flex flex-col gap-rc-2xs">
        <span className="text-label font-medium uppercase leading-4 tracking-label text-text-tertiary">
          Voiceover — the narrator, over the whole film
        </span>
        <div className="rounded-control bg-bg-inset px-rc-sm py-[10px] text-small leading-[1.5] text-text-primary">
          {voiceOver || '—'}
        </div>
      </div>
    )
  }

  // canvas: "Text fields · focus · error" - the validation-error border is
  // --status-failed-fg, a different, stronger token than the save-failure textarea's
  // --status-failed-line (a distinct visual register for "this value is rejected" vs
  // "this write failed" - the latter isn't styled on the textarea itself today).
  const textareaClassName = `${fieldTextareaBaseClassName} ${showValidationError ? 'border-status-failed-fg' : 'border-border-strong'}`

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
        onFocus={() => setFocused(true)}
        onBlur={handleBlur}
        rows={2}
        className={textareaClassName}
      />
      {status === 'failed' && !showValidationError && (
        <span className="text-meta text-text-tertiary">This edit is still on this screen only. Retry to store it.</span>
      )}
      {showValidationError && <span className="text-meta text-status-failed-fg">{EMPTY_VOICEOVER_MESSAGE}</span>}
    </div>
  )
})
