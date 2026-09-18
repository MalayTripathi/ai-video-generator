'use client'

import { useMemo, useState, type KeyboardEvent, type MouseEvent } from 'react'
import { useRouter } from 'next/navigation'
import { VoiceoverField } from './voiceover-field'
import { VisualDescriptionField } from './visual-description-field'
import { CameraOriginFields } from './camera-origin-fields'
import { CameraDerivationStatus } from './camera-derivation-status'
import { BoundElements } from './bound-elements'
import { DialogueSection } from './dialogue-section'
import { DurationStepper } from './duration-stepper'
import { SaveStatusIndicator } from './save-status-indicator'
import { DeleteShotConfirmModal } from './delete-shot-confirm-modal'
import { useShots } from './shots-context'
import { useCameraDerivation, type CameraFieldUpdate } from './use-camera-derivation'
import type { FieldSaveStatus } from './use-field-save'
import type { DisplayShot } from './types'
import { CAMERA_FIELD_NAMES, type CameraFieldName } from '@/lib/prompts/camera-derivation'
import type { CameraOrigin } from '@/lib/config/enums'
import { deleteShot } from '../actions'
import { identDotClassName } from '@/lib/element-type-labels'

// canvas: "11 Delete affordance" - the exact bin glyph, shared by the collapsed
// icon-only trigger and the expanded icon+label trigger so the two read as one control
// changing size, not two controls.
function TrashIcon() {
  return (
    <svg width="13" height="14" viewBox="0 0 14 15" fill="none" aria-hidden="true">
      <path
        d="M1.75 3.9h10.5M5.25 3.9V2.5c0-.36.29-.65.65-.65h2.2c.36 0 .65.29.65.65v1.4M3.2 3.9l.45 8.4c.02.4.35.7.75.7h5.2c.4 0 .73-.3.75-.7l.45-8.4"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinecap="round"
      />
      <path d="M5.8 6.5v4M8.2 6.5v4" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
    </svg>
  )
}

type DeleteState = { status: 'idle' } | { status: 'confirming'; error?: string } | { status: 'deleting' }

const CAMERA_FIELD_LABELS: Record<CameraFieldName, string> = {
  shot_size: 'shot size',
  camera_angle: 'camera angle',
  camera_movement: 'camera movement',
}

type FieldStatusEntry = { status: FieldSaveStatus; retry: () => void }

const FIELD_LABELS: Record<string, string> = {
  voice_over: "Voiceover didn't save",
  visual_description: "Visual description didn't save",
  duration_sec: "Duration didn't save",
  shot_size: "Shot size didn't save",
  camera_angle: "Camera angle didn't save",
  camera_movement: "Camera movement didn't save",
}

// Converts the route's per-field { value, origin } result into a DisplayShot patch -
// only the fields present in `updated` (i.e. the ones write-back actually applied) are
// touched, leaving every other field (including untouched 'override' ones) alone.
function toShotPatch(updated: Partial<Record<CameraFieldName, CameraFieldUpdate>>): Partial<DisplayShot> {
  const patch: Partial<DisplayShot> = {}
  if (updated.shot_size) {
    patch.shot_size = updated.shot_size.value
    patch.shot_size_origin = updated.shot_size.origin
  }
  if (updated.camera_angle) {
    patch.camera_angle = updated.camera_angle.value
    patch.camera_angle_origin = updated.camera_angle.origin
  }
  if (updated.camera_movement) {
    patch.camera_movement = updated.camera_movement.value
    patch.camera_movement_origin = updated.camera_movement.origin
  }
  return patch
}

function labelForKey(key: string) {
  if (key.startsWith('dialogue:')) return "A dialogue line didn't save"
  return FIELD_LABELS[key] ?? "A field didn't save"
}

// Header rollup precedence: failed > saving > saved > quiet (canvas: "Save status · two
// tiers"). One failure names its field; several collapse to a count with "Retry all".
// Saved decays with the same 2s timing as the per-field indicator, driven by the same
// per-field hooks - this just reads the worst state across them.
function rollupStatus(entries: Record<string, FieldStatusEntry>) {
  const failedKeys = Object.entries(entries).filter(([, e]) => e.status === 'failed')
  if (failedKeys.length === 1) {
    const [key, entry] = failedKeys[0]
    return { kind: 'failed' as const, label: labelForKey(key), retryLabel: 'Retry', retryAll: entry.retry }
  }
  if (failedKeys.length > 1) {
    return {
      kind: 'failed' as const,
      label: `${failedKeys.length} fields didn't save`,
      retryLabel: 'Retry all',
      retryAll: () => failedKeys.forEach(([, e]) => e.retry()),
    }
  }
  const values = Object.values(entries)
  if (values.some((e) => e.status === 'saving')) return { kind: 'saving' as const }
  if (values.some((e) => e.status === 'saved')) return { kind: 'saved' as const }
  return { kind: 'quiet' as const }
}

export function ShotCard({ shot }: { shot: DisplayShot }) {
  const {
    projectId,
    updateShotLocal,
    removeShotLocal,
    readOnly,
    lockedShotKeys,
    expandedShotId,
    expandShot,
    collapseShot,
  } = useShots()
  const router = useRouter()
  const isLocked = lockedShotKeys.has(shot.shot_key)
  const expanded = expandedShotId === shot.id
  const [deleteState, setDeleteState] = useState<DeleteState>({ status: 'idle' })
  const [fieldStatus, setFieldStatus] = useState<Record<string, FieldStatusEntry>>({})
  const [previousCameraValues, setPreviousCameraValues] = useState<Partial<Record<CameraFieldName, string | null>>>({})
  const { status: derivationStatus, pendingFields, trigger, retry: retryDerivation } = useCameraDerivation(
    projectId,
    shot.id
  )

  function snapshotCameraValues() {
    setPreviousCameraValues({
      shot_size: shot.shot_size,
      camera_angle: shot.camera_angle,
      camera_movement: shot.camera_movement,
    })
  }

  function handleFieldStatusChange(key: string, status: FieldSaveStatus, retry: () => void) {
    setFieldStatus((prev) => ({ ...prev, [key]: { status, retry } }))
  }

  // Prunes a key entirely rather than setting it to 'idle' - a row that's been removed
  // (e.g. a deleted dialogue line) has no field left to report a status for, and an
  // 'idle' entry left behind would still occupy a slot in `fieldStatus` forever. This is
  // what makes the header rollup resolve when a row is removed mid-save: without it,
  // `rollupStatus` keeps scanning a stale 'saving'/'failed' entry nothing will ever
  // update again, since the component that used to report it has unmounted.
  function clearFieldStatus(key: string) {
    setFieldStatus((prev) => {
      if (!(key in prev)) return prev
      const next = { ...prev }
      delete next[key]
      return next
    })
  }

  const rollup = useMemo(() => rollupStatus(fieldStatus), [fieldStatus])
  const boundCharacters = useMemo(() => shot.elements.filter((el) => el.type === 'character'), [shot.elements])

  function handleVisualDescriptionSaved(patch: { visual_description: string }) {
    updateShotLocal(shot.id, patch)
    // Always re-derive on an actually-changed, successfully-saved description edit -
    // even when every camera field is currently 'override'. New description text is
    // real evidence that deserves a real check; write-back still only overwrites an
    // override field when Claude finds explicit new evidence for it (see CLAUDE.md's
    // camera-scope invariant and the description-wins-over-override rule).
    snapshotCameraValues()
    void trigger({ fields: [...CAMERA_FIELD_NAMES] }).then((updated) => {
      if (updated) updateShotLocal(shot.id, toShotPatch(updated))
    })
  }

  function handleCameraFieldSaved(field: CameraFieldName, value: string) {
    const originKey = `${field}_origin` as const
    updateShotLocal(shot.id, { [field]: value, [originKey]: 'override' } as Partial<DisplayShot>)
  }

  function handleRevert(field: CameraFieldName) {
    snapshotCameraValues()
    void trigger({ fields: [field], revertField: field }).then((updated) => {
      if (updated) updateShotLocal(shot.id, toShotPatch(updated))
    })
  }

  function handleResetAll() {
    snapshotCameraValues()
    void trigger({ fields: [...CAMERA_FIELD_NAMES], resetAll: true }).then((updated) => {
      if (updated) updateShotLocal(shot.id, toShotPatch(updated))
    })
  }

  function handleDeleteTriggerClick(event: MouseEvent) {
    event.stopPropagation()
    if (deleteState.status !== 'idle') return
    setDeleteState({ status: 'confirming' })
  }

  function handleDeleteTriggerKeyDown(event: KeyboardEvent) {
    event.stopPropagation()
  }

  function handleCancelDelete() {
    setDeleteState({ status: 'idle' })
  }

  async function handleConfirmDelete() {
    if (deleteState.status !== 'confirming') return
    setDeleteState({ status: 'deleting' })
    const result = await deleteShot(shot.id)
    if (!result.success) {
      setDeleteState({ status: 'confirming', error: result.error })
      return
    }
    removeShotLocal(shot.id)
    router.refresh()
  }

  const pendingFieldLabels = CAMERA_FIELD_NAMES.filter((f) => pendingFields.has(f)).map((f) => CAMERA_FIELD_LABELS[f])
  const origins: Record<CameraFieldName, CameraOrigin> = {
    shot_size: shot.shot_size_origin,
    camera_angle: shot.camera_angle_origin,
    camera_movement: shot.camera_movement_origin,
  }
  const heldFieldLabels =
    derivationStatus === 'running'
      ? CAMERA_FIELD_NAMES.filter((f) => !pendingFields.has(f) && origins[f] === 'override').map((f) => CAMERA_FIELD_LABELS[f])
      : []
  const showResetAll = CAMERA_FIELD_NAMES.some((f) => origins[f] !== 'auto')

  // canvas: "08 Workbench" / "09A Card at rest" - the expanded card is border-accent,
  // distinct from the resting border-subtle. Failed still wins over accent (a red border
  // must stay findable even on the currently-open card).
  const cardBorderClassName =
    rollup.kind === 'failed' ? 'border-status-failed-line' : expanded ? 'border-accent' : 'border-border-subtle'
  const durationLabel = shot.duration_sec === null ? '—' : `${shot.duration_sec.toFixed(1)}s`

  // Collapsed: the whole card is the expand target (canvas shows no dedicated "Expand"
  // button, just cursor:pointer + a hover border change) - a11y via role="button" +
  // keyboard handling rather than a visible label. Expanded: the root gets no click
  // handler at all, so clicking into any field never collapses the card underneath the
  // person; "Collapse" stays a real, explicit text link in the header.
  const collapsedInteractionProps = !expanded
    ? {
        role: 'button' as const,
        tabIndex: 0,
        'aria-expanded': false,
        onClick: () => expandShot(shot.id),
        onKeyDown: (event: KeyboardEvent<HTMLDivElement>) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault()
            expandShot(shot.id)
          }
        },
      }
    : {}

  return (
    <>
    <div
      data-testid="shot-card"
      data-shot-key={shot.shot_key}
      data-locked={isLocked}
      className={`relative flex flex-col overflow-hidden rounded-control border bg-bg-surface shadow-card ${
        isLocked ? 'border-accent-faint' : `${cardBorderClassName} ${!expanded ? 'cursor-pointer hover:border-border-strong' : ''}`
      }`}
      {...(isLocked ? {} : collapsedInteractionProps)}
    >
      {isLocked && (
        <>
          <span className="absolute inset-y-0 left-0 w-[2px] bg-accent" aria-hidden />
          <div className="flex flex-none items-center gap-[7px] border-b border-border-subtle bg-accent-wash px-rc-md py-[7px]">
            <span
              className="h-[5px] w-[5px] flex-none rounded-full bg-accent"
              style={{ animation: 'rc-pulse 1.3s ease-in-out infinite' }}
            />
            <span className="text-meta text-accent">Agent is rewriting this shot</span>
          </div>
        </>
      )}
      <div className={`flex flex-col gap-rc-2xs p-3 px-rc-md ${isLocked ? 'pointer-events-none cursor-not-allowed opacity-[0.55]' : ''}`}>
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-rc-xs">
          <span className="text-body font-medium tracking-micro text-text-primary">
            Shot {shot.order_index + 1}
          </span>
          {shot.section_label && (
            <span className="rounded-badge bg-bg-inset px-rc-xs py-[3px] text-chip text-text-secondary">
              {shot.section_label}
            </span>
          )}
        </div>
        {!expanded && <span className="font-mono text-small text-text-tertiary">{durationLabel}</span>}
        {expanded && (
          <div className="flex items-center gap-rc-sm" data-testid="card-save-rollup" data-rollup-kind={rollup.kind}>
            {rollup.kind === 'failed' && (
              <SaveStatusIndicator status="failed" label={rollup.label} onRetry={rollup.retryAll} retryLabel={rollup.retryLabel} />
            )}
            {rollup.kind === 'saving' && <SaveStatusIndicator status="saving" label="" />}
            {rollup.kind === 'saved' && <SaveStatusIndicator status="saved" label="" />}
            <button
              type="button"
              onClick={() => collapseShot()}
              className="cursor-pointer text-small text-text-secondary hover:text-text-primary"
            >
              Collapse
            </button>
          </div>
        )}
      </div>

      {!expanded && (
        <>
          {shot.voice_over && (
            <div className="flex gap-rc-xs pl-px">
              <span className="w-[2px] flex-none rounded-[1px] bg-accent-faint" aria-hidden />
              <span className="pt-[3px] font-mono text-mono text-text-tertiary">vo</span>
              <span className="text-body leading-[1.5] text-text-primary">{shot.voice_over}</span>
            </div>
          )}

          {shot.dialogue.map((line) => (
            <div key={line.id} className="grid grid-cols-[84px_1fr] gap-rc-xs pl-px">
              <span className="pt-[1px] text-label uppercase tracking-label text-text-tertiary">
                {line.element_name}
              </span>
              <span className="text-body leading-[1.5] text-text-secondary">&ldquo;{line.line}&rdquo;</span>
            </div>
          ))}

          {shot.visual_description && (
            <div className="text-small leading-[1.5] text-text-secondary">{shot.visual_description}</div>
          )}

          {(shot.elements.length > 0 || !readOnly) && (
            <div className="mt-0.5 flex items-end justify-between gap-rc-sm">
              <div className="flex flex-wrap gap-rc-2xs">
                {shot.elements.map((el) => (
                  <span
                    key={el.id}
                    className="flex items-center gap-[5px] rounded-badge bg-bg-inset px-rc-xs py-[3px] text-chip text-text-secondary"
                  >
                    <span className={`h-[5px] w-[5px] rounded-full ${identDotClassName(el.type)}`} aria-hidden />
                    {el.name}
                  </span>
                ))}
              </div>
              {/* canvas: "11 Delete affordance" (collapsed) - the bin sits in the same
                  trailing row as the element chips, right-aligned, always visible (not
                  hover-only: deleting is the only way to remove a shot). Read-only
                  workbench has no delete affordance at all (canvas: "Locked · workbench
                  read-only"). */}
              {!readOnly && (
                <button
                  type="button"
                  data-testid="delete-shot-trigger"
                  aria-label="Delete shot"
                  title="Delete shot"
                  onClick={handleDeleteTriggerClick}
                  onKeyDown={handleDeleteTriggerKeyDown}
                  disabled={deleteState.status !== 'idle'}
                  className="-mb-[6px] -mr-[6px] flex h-[26px] w-[26px] flex-none cursor-pointer items-center justify-center rounded-badge text-text-tertiary hover:bg-status-failed-bg hover:text-status-failed-fg disabled:cursor-not-allowed"
                >
                  <TrashIcon />
                </button>
              )}
            </div>
          )}
        </>
      )}

      {expanded && (
        <div className="flex flex-col gap-rc-md pt-rc-2xs">
          <VoiceoverField
            shotId={shot.id}
            shotKey={shot.shot_key}
            voiceOver={shot.voice_over}
            hasDialogue={shot.dialogue.length > 0}
            readOnly={readOnly}
            onSaved={(patch) => updateShotLocal(shot.id, patch)}
            onStatusChange={(status, retry) => handleFieldStatusChange('voice_over', status, retry)}
          />

          <DialogueSection
            shotId={shot.id}
            shotKey={shot.shot_key}
            dialogue={shot.dialogue}
            boundCharacters={boundCharacters}
            readOnly={readOnly}
            onFieldStatusChange={handleFieldStatusChange}
            onFieldStatusClear={clearFieldStatus}
          />

          <VisualDescriptionField
            shotId={shot.id}
            shotKey={shot.shot_key}
            visualDescription={shot.visual_description}
            readOnly={readOnly}
            onSaved={handleVisualDescriptionSaved}
            onStatusChange={(status, retry) => handleFieldStatusChange('visual_description', status, retry)}
          />

          <div className="flex flex-col gap-rc-2xs">
            <CameraOriginFields
              shotId={shot.id}
              shotSize={shot.shot_size}
              shotSizeOrigin={shot.shot_size_origin}
              cameraAngle={shot.camera_angle}
              cameraAngleOrigin={shot.camera_angle_origin}
              cameraMovement={shot.camera_movement}
              cameraMovementOrigin={shot.camera_movement_origin}
              pendingFields={pendingFields}
              previousValues={previousCameraValues}
              justSettled={derivationStatus === 'succeeded'}
              readOnly={readOnly}
              onFieldSaved={handleCameraFieldSaved}
              onFieldStatusChange={handleFieldStatusChange}
              onRevert={handleRevert}
            />
            {!readOnly && (
              <CameraDerivationStatus
                status={derivationStatus}
                pendingFieldLabels={pendingFieldLabels}
                heldFieldLabels={heldFieldLabels}
                onRetry={retryDerivation}
                showResetAll={showResetAll}
                onResetAll={handleResetAll}
              />
            )}
          </div>

          <BoundElements shotId={shot.id} elements={shot.elements} readOnly={readOnly} />

          <div className="flex items-end justify-between gap-rc-md">
            <DurationStepper
              shotId={shot.id}
              shotKey={shot.shot_key}
              durationSec={shot.duration_sec}
              readOnly={readOnly}
              onStatusChange={(status, retry) => handleFieldStatusChange('duration_sec', status, retry)}
            />
            {/* canvas: "11 Delete affordance" (expanded) - the same bin plus its label,
                the one-control-two-sizes transition from the collapsed trigger. Read-only
                workbench has no delete affordance at all (canvas: "Locked · workbench
                read-only"). */}
            {!readOnly && (
              <button
                type="button"
                data-testid="delete-shot-trigger"
                onClick={handleDeleteTriggerClick}
                onKeyDown={handleDeleteTriggerKeyDown}
                disabled={deleteState.status !== 'idle'}
                className="-mb-[5px] -mr-2 flex h-[26px] flex-none cursor-pointer items-center gap-[6px] rounded-badge py-0 pl-[5px] pr-2 text-small text-text-tertiary hover:bg-status-failed-bg hover:text-status-failed-fg disabled:cursor-not-allowed"
              >
                <span className="flex w-4 justify-center">
                  <TrashIcon />
                </span>
                Delete shot
              </button>
            )}
          </div>
        </div>
      )}
      </div>
    </div>
    <DeleteShotConfirmModal
      open={deleteState.status === 'confirming' || deleteState.status === 'deleting'}
      shotNumber={shot.order_index + 1}
      elementsCount={shot.elements.length}
      pending={deleteState.status === 'deleting'}
      error={deleteState.status === 'confirming' ? deleteState.error : undefined}
      onConfirm={handleConfirmDelete}
      onCancel={handleCancelDelete}
    />
    </>
  )
}
