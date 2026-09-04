'use client'

import { memo, useEffect, useMemo, useState } from 'react'
import { saveDialogueLine } from '../actions'
import { SaveStatusIndicator } from './save-status-indicator'
import { CustomSelect, type SelectOption } from './custom-select'
import { useFieldSave, type FieldSaveStatus } from './use-field-save'
import type { DisplayElement } from './types'

function RemoveIcon() {
  return (
    <svg width="9" height="9" viewBox="0 0 9 9" fill="none" aria-hidden="true">
      <path d="M1 1l7 7M8 1l-7 7" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  )
}

export type DialogueRowValue = { id?: string; elementId: string; elementName?: string; line: string }

// A row saves like any other field - speaker on change, words on blur - and reports
// status inline so the row keeps its width (canvas: "Dialogue rows" close-up). A brand
// new row (no `id` yet) lives entirely in this component's local state until both
// speaker and line are filled; nothing half-formed reaches the database, and there's no
// card-wide dirty-state concept for it - discarding an incomplete row costs nothing.
export const DialogueRow = memo(function DialogueRow({
  shotId,
  initial,
  boundCharacters,
  onSaved,
  onRequestRemove,
  onStatusChange,
}: {
  shotId: string
  initial: DialogueRowValue
  boundCharacters: DisplayElement[]
  onSaved: (value: { id: string; elementId: string; line: string }) => void
  onRequestRemove: () => void
  onStatusChange: (status: FieldSaveStatus, retry: () => void) => void
}) {
  const [id, setId] = useState(initial.id)
  const [elementId, setElementId] = useState(initial.elementId)
  const [line, setLine] = useState(initial.line)
  const [persisted, setPersisted] = useState(initial)
  const { status, run, retry } = useFieldSave()

  useEffect(() => {
    onStatusChange(status, retry)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status])

  const isOutOfList = Boolean(id) && elementId !== '' && !boundCharacters.some((el) => el.id === elementId)
  const canSave = elementId !== '' && line.trim() !== ''
  const incomplete = !canSave
  const speakerOptions: SelectOption[] = useMemo(
    () => boundCharacters.map((el) => ({ value: el.id, label: el.name })),
    [boundCharacters]
  )

  function persistIfReady(nextElementId: string, nextLine: string) {
    const trimmedLine = nextLine.trim()
    if (nextElementId === '' || trimmedLine === '') return
    if (id && nextElementId === persisted.elementId && trimmedLine === persisted.line) return

    void run(async () => {
      const result = await saveDialogueLine({ id, shotId, elementId: nextElementId, line: trimmedLine })
      if (result.success) {
        setId(result.id)
        setPersisted({ id: result.id, elementId: nextElementId, line: trimmedLine })
        setLine(trimmedLine)
        onSaved({ id: result.id, elementId: nextElementId, line: trimmedLine })
      }
      return result
    })
  }

  function handleSpeakerChange(nextElementId: string) {
    setElementId(nextElementId)
    persistIfReady(nextElementId, line)
  }

  function handleLineBlur() {
    persistIfReady(elementId, line)
  }

  const lineBorderClassName =
    status === 'failed'
      ? 'border-status-failed-line'
      : status === 'saving'
        ? 'border-border-strong'
        : incomplete && line.trim() === ''
          ? 'border-dashed border-border-strong'
          : 'border-border-subtle'

  return (
    <div className="flex items-start gap-rc-xs" data-testid="dialogue-row">
      <div className="flex flex-1 flex-col gap-[3px]">
        <div className="flex items-center gap-rc-xs">
          {isOutOfList ? (
            <span data-testid="dialogue-speaker-readonly" className="w-[156px] text-small text-text-secondary">
              {initial.elementName || 'Unbound speaker'}
            </span>
          ) : (
            <div className="flex h-7 w-[156px] items-center rounded-control border border-border-subtle px-rc-xs text-small text-text-primary">
              <CustomSelect
                ariaLabel="Speaker"
                options={speakerOptions}
                value={elementId || null}
                onCommit={handleSpeakerChange}
                placeholder="Choose speaker"
              />
            </div>
          )}
          <div className={`flex h-7 flex-1 items-center justify-between gap-rc-xs rounded-control border px-rc-xs ${lineBorderClassName}`}>
            <input
              aria-label="Line"
              value={line}
              onChange={(event) => setLine(event.target.value)}
              onBlur={handleLineBlur}
              placeholder="What they say…"
              className="w-full bg-transparent text-small outline-none text-text-primary placeholder:text-text-quiet"
            />
            <SaveStatusIndicator status={status} label="Save failed" onRetry={retry} />
          </div>
        </div>
        {incomplete && (
          <span className="text-meta text-text-tertiary">
            A line is kept once it has a speaker and words. This one isn&rsquo;t stored yet.
          </span>
        )}
      </div>
      <button
        type="button"
        onClick={onRequestRemove}
        aria-label="Remove dialogue row"
        className="mt-1 flex h-[26px] w-[26px] flex-none cursor-pointer items-center justify-center rounded-full text-text-tertiary hover:bg-status-failed-bg hover:text-status-failed-fg"
      >
        <RemoveIcon />
      </button>
    </div>
  )
})
