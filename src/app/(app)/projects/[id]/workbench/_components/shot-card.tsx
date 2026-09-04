'use client'

import { useMemo, useState, type KeyboardEvent } from 'react'
import { VoiceoverField } from './voiceover-field'
import { VisualDescriptionField } from './visual-description-field'
import { CameraOriginFields } from './camera-origin-fields'
import { CameraDerivationStatus } from './camera-derivation-status'
import { BoundElements } from './bound-elements'
import { DialogueSection } from './dialogue-section'
import { DurationStepper } from './duration-stepper'
import { SaveStatusIndicator } from './save-status-indicator'
import { useShots } from './shots-context'
import { useCameraDerivation, type CameraFieldUpdate } from './use-camera-derivation'
import type { FieldSaveStatus } from './use-field-save'
import type { DisplayElement, DisplayShot } from './types'
import { CAMERA_FIELD_NAMES, type CameraFieldName } from '@/lib/prompts/camera-derivation'
import type { CameraOrigin } from '@/lib/config/enums'

const CAMERA_FIELD_LABELS: Record<CameraFieldName, string> = {
  shot_size: 'shot size',
  camera_angle: 'camera angle',
  camera_movement: 'camera movement',
}

function elementDotClassName(el: DisplayElement) {
  if (el.reference_image_path) return 'bg-status-done-fg'
  if (el.status === 'generating') return 'bg-status-active-fg'
  if (el.status === 'failed') return 'bg-status-failed-fg'
  return 'bg-border-strong' // pending / no reference - the only state reachable this task
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
  const { projectId, updateShotLocal } = useShots()
  const [expanded, setExpanded] = useState(false)
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

  const cardBorderClassName = rollup.kind === 'failed' ? 'border-status-failed-line' : 'border-border-subtle'
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
        onClick: () => setExpanded(true),
        onKeyDown: (event: KeyboardEvent<HTMLDivElement>) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault()
            setExpanded(true)
          }
        },
      }
    : {}

  return (
    <div
      data-testid="shot-card"
      className={`flex flex-col gap-rc-2xs rounded-control border bg-bg-surface p-3 px-rc-md shadow-card ${cardBorderClassName} ${
        !expanded ? 'cursor-pointer hover:border-border-strong' : ''
      }`}
      {...collapsedInteractionProps}
    >
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
              onClick={() => setExpanded(false)}
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

          {shot.elements.length > 0 && (
            <div className="mt-0.5 flex flex-wrap gap-rc-2xs">
              {shot.elements.map((el) => (
                <span
                  key={el.id}
                  className="flex items-center gap-[5px] rounded-badge bg-bg-inset px-rc-xs py-[3px] text-chip text-text-secondary"
                >
                  <span className={`h-[5px] w-[5px] rounded-full ${elementDotClassName(el)}`} aria-hidden />
                  {el.name}
                </span>
              ))}
            </div>
          )}
        </>
      )}

      {expanded && (
        <div className="flex flex-col gap-rc-md pt-rc-2xs">
          <VoiceoverField
            shotId={shot.id}
            voiceOver={shot.voice_over}
            onSaved={(patch) => updateShotLocal(shot.id, patch)}
            onStatusChange={(status, retry) => handleFieldStatusChange('voice_over', status, retry)}
          />

          <DialogueSection
            shotId={shot.id}
            dialogue={shot.dialogue}
            boundCharacters={boundCharacters}
            onFieldStatusChange={handleFieldStatusChange}
            onFieldStatusClear={clearFieldStatus}
          />

          <VisualDescriptionField
            shotId={shot.id}
            visualDescription={shot.visual_description}
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
              onFieldSaved={handleCameraFieldSaved}
              onFieldStatusChange={handleFieldStatusChange}
              onRevert={handleRevert}
            />
            <CameraDerivationStatus
              status={derivationStatus}
              pendingFieldLabels={pendingFieldLabels}
              heldFieldLabels={heldFieldLabels}
              onRetry={retryDerivation}
              showResetAll={showResetAll}
              onResetAll={handleResetAll}
            />
          </div>

          <BoundElements elements={shot.elements} />

          <div className="flex items-end justify-between gap-rc-md">
            <DurationStepper
              shotId={shot.id}
              durationSec={shot.duration_sec}
              onStatusChange={(status, retry) => handleFieldStatusChange('duration_sec', status, retry)}
            />
            {/* Deleting a shot is C4's job (alongside the agent's delete_shot tool) - rendered
                exactly as the canvas shows it, with no handler, same as the other controls
                whose real functionality belongs to a later slice. */}
            <span className="cursor-default text-small text-text-tertiary underline decoration-border-strong">
              Delete shot
            </span>
          </div>
        </div>
      )}
    </div>
  )
}
