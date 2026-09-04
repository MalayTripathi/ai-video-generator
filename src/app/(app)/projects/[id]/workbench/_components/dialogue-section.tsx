'use client'

import { useEffect, useRef, useState } from 'react'
import { deleteDialogueLine } from '../actions'
import { DialogueRow, type DialogueRowValue } from './dialogue-row'
import { useShots } from './shots-context'
import type { FieldSaveStatus } from './use-field-save'
import type { DisplayDialogueLine, DisplayElement } from './types'

let draftKeySeq = 0

export function DialogueSection({
  shotId,
  dialogue,
  boundCharacters,
  onFieldStatusChange,
  onFieldStatusClear,
}: {
  shotId: string
  dialogue: DisplayDialogueLine[]
  boundCharacters: DisplayElement[]
  onFieldStatusChange: (fieldKey: string, status: FieldSaveStatus, retry: () => void) => void
  onFieldStatusClear: (fieldKey: string) => void
}) {
  const { updateShotLocal } = useShots()
  const [rows, setRows] = useState<DisplayDialogueLine[]>(dialogue)
  const [drafts, setDrafts] = useState<{ key: string }[]>([])

  // Sync this shot's dialogue back to the card-list-level ShotsProvider whenever it
  // changes locally, via an effect rather than inline inside a setRows updater -
  // updater functions must stay pure (React may invoke them during render), and calling
  // another component's setState from inside one triggers React's
  // "Cannot update a component while rendering a different component" warning.
  const isFirstRender = useRef(true)
  useEffect(() => {
    if (isFirstRender.current) {
      isFirstRender.current = false
      return
    }
    updateShotLocal(shotId, { dialogue: rows })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows])

  function handleAddLine() {
    setDrafts((prev) => [...prev, { key: `draft-${draftKeySeq++}` }])
  }

  function handleDraftSaved(draftKey: string, value: { id: string; elementId: string; line: string }) {
    setDrafts((prev) => prev.filter((d) => d.key !== draftKey))
    setRows((prev) => {
      const character = boundCharacters.find((el) => el.id === value.elementId)
      return [
        ...prev,
        {
          id: value.id,
          order_index: prev.length,
          element_id: value.elementId,
          element_name: character?.name ?? '',
          line: value.line,
        },
      ]
    })
    // This is the actual root cause of the stuck-spinner bug, not just row removal: a
    // saved draft is promoted from the `drafts` array (key `dialogue:${draftKey}`) to
    // the `rows` array (key `dialogue:${value.id}`) - a different React key, which
    // forces a genuine unmount-then-remount of DialogueRow rather than an update of the
    // same instance. The old instance's own 'saving' -> 'saved' transition, which fires
    // from inside this same save's continuation, loses the race against that remount:
    // React tears the old subtree down as part of applying the `rows`/`drafts` update
    // above, so the old instance's pending status effect never runs, and the header's
    // per-field map is left holding a `dialogue:${draftKey}` entry stuck at 'saving'
    // forever - nothing under that key will ever report again, since the row that owned
    // it no longer exists. Clearing it here, at the exact moment of promotion, is what
    // makes "add a line and let it save" resolve on its own, with no removal needed.
    onFieldStatusClear(`dialogue:${draftKey}`)
  }

  function handleRowSaved(rowId: string, value: { id: string; elementId: string; line: string }) {
    setRows((prev) => {
      const character = boundCharacters.find((el) => el.id === value.elementId)
      return prev.map((row) =>
        row.id === rowId ? { ...row, element_id: value.elementId, element_name: character?.name ?? row.element_name, line: value.line } : row
      )
    })
  }

  async function handleRemoveSavedRow(rowId: string) {
    const previous = rows
    const next = rows.filter((row) => row.id !== rowId).map((row, index) => ({ ...row, order_index: index }))
    setRows(next)
    // Clear this row's header-rollup entry at the moment of removal, not on some later
    // timeout - the row that was reporting it is about to unmount and will never report
    // again, so a still-'saving'/'failed' entry would otherwise sit in the rollup map
    // forever (see clearFieldStatus's comment in shot-card.tsx for the full root cause).
    onFieldStatusClear(`dialogue:${rowId}`)
    const result = await deleteDialogueLine(rowId, shotId)
    if (!result.success) {
      // Best-effort: restore the row list so a failed delete doesn't silently vanish a
      // line. There's no per-row "delete failed" status slot in this design, so this is
      // a plain rollback rather than a retryable indicator; the row's status simply
      // restarts clean (idle) rather than being restored to whatever it was before.
      setRows(previous)
    }
  }

  function handleRemoveDraft(draftKey: string) {
    setDrafts((prev) => prev.filter((d) => d.key !== draftKey))
    onFieldStatusClear(`dialogue:${draftKey}`)
  }

  const canAddLine = boundCharacters.length > 0

  return (
    <div className="flex flex-col gap-rc-xs">
      <div className="flex items-center justify-between">
        <span className="text-label font-medium uppercase leading-4 tracking-label text-text-tertiary">Character dialogue</span>
        <div className="flex items-center gap-rc-xs">
          {!canAddLine && <span className="text-meta text-text-tertiary">Bind a character to this shot first</span>}
          <button
            type="button"
            disabled={!canAddLine}
            onClick={handleAddLine}
            className="cursor-pointer rounded-badge bg-accent-wash px-rc-xs py-[3px] text-chip font-medium text-accent hover:bg-accent-wash-strong disabled:cursor-not-allowed disabled:opacity-[0.45] disabled:hover:bg-accent-wash"
          >
            + Add line
          </button>
        </div>
      </div>

      {rows.length === 0 && drafts.length === 0 && (
        <div className="text-small text-text-tertiary">No spoken lines in this shot. Add one if a character speaks on camera.</div>
      )}

      {rows.map((row) => (
        <DialogueRow
          key={row.id}
          shotId={shotId}
          initial={
            { id: row.id, elementId: row.element_id, elementName: row.element_name, line: row.line } satisfies DialogueRowValue
          }
          boundCharacters={boundCharacters}
          onSaved={(value) => handleRowSaved(row.id, value)}
          onRequestRemove={() => void handleRemoveSavedRow(row.id)}
          onStatusChange={(status, retry) => onFieldStatusChange(`dialogue:${row.id}`, status, retry)}
        />
      ))}

      {drafts.map((draft) => (
        <DialogueRow
          key={draft.key}
          shotId={shotId}
          initial={{ elementId: '', line: '' }}
          boundCharacters={boundCharacters}
          onSaved={(value) => handleDraftSaved(draft.key, value)}
          onRequestRemove={() => handleRemoveDraft(draft.key)}
          onStatusChange={(status, retry) => onFieldStatusChange(`dialogue:${draft.key}`, status, retry)}
        />
      ))}
    </div>
  )
}
