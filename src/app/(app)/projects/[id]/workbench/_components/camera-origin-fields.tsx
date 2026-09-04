'use client'

import { memo, useEffect } from 'react'
import { SHOT_SIZES, CAMERA_ANGLES, CAMERA_MOVEMENTS, type CameraOrigin } from '@/lib/config/enums'
import { shotSizeLabel, cameraAngleLabel, cameraMovementLabel } from '@/lib/camera-labels'
import type { CameraFieldName } from '@/lib/prompts/camera-derivation'
import { updateShotSize, updateShotCameraAngle, updateShotCameraMovement, type ShotFieldSaveResult } from '../actions'
import { SaveStatusIndicator } from './save-status-indicator'
import { CustomSelect, type SelectOption } from './custom-select'
import { useFieldSave, type FieldSaveStatus } from './use-field-save'
import { Spinner } from '@/components/spinner'

export function RevertIcon() {
  return (
    <svg width="11" height="10" viewBox="0 0 12 11" fill="none" aria-hidden="true" className="flex-none">
      <path d="M1.5 5.5a4.5 4.5 0 1 0 1.6-3.45" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
      <path d="M1 0.6v2.1h2.1" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

// One field: a custom select, saving on commit (a commit IS the change - there is no
// separate blur moment the way a text field has). `pending` comes from the shot-card's
// useCameraDerivation hook - true only while THIS field is part of an in-flight
// re-derivation request, never for a sibling 'override' field left untouched by that
// request (see CLAUDE.md - that contrast is the entire point of the pending state).
function CameraField({
  label,
  options,
  value,
  origin,
  pending,
  previousValue,
  justSettled,
  formatValue,
  save,
  onSaved,
  onStatusChange,
  onRevert,
}: {
  label: string
  options: readonly string[]
  value: string | null
  origin: CameraOrigin
  pending: boolean
  previousValue?: string | null
  justSettled?: boolean
  formatValue: (value: string | null) => string
  save: (value: string) => Promise<ShotFieldSaveResult>
  onSaved: (value: string) => void
  onStatusChange: (status: FieldSaveStatus, retry: () => void) => void
  onRevert: () => void
}) {
  const { status, run, retry } = useFieldSave()

  useEffect(() => {
    onStatusChange(status, retry)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status])

  const selectOptions: SelectOption[] = options.map((option) => ({ value: option, label: formatValue(option) }))

  function handleCommit(next: string) {
    // A re-selected value is a real no-op once origin is already 'override', but the
    // same value while origin is still 'auto'/'derived' is not - origin still needs to
    // move to 'override'. Compares the (value, origin) pair, matching every other
    // per-field save action's diff-before-write rule.
    if (next === value && origin === 'override') return
    void run(async () => {
      const result = await save(next)
      if (result.success) onSaved(next)
      return result
    })
  }

  const showSettledNote =
    justSettled && !pending && origin === 'derived' && previousValue !== undefined && previousValue !== value

  return (
    <div className="flex flex-col gap-rc-2xs">
      <div className="flex min-h-4 items-center justify-between gap-rc-xs">
        <span
          className={`text-label font-medium uppercase leading-4 tracking-label ${pending ? 'text-text-quiet' : 'text-text-tertiary'}`}
        >
          {label}
        </span>
        <SaveStatusIndicator status={status} label={`${label} didn't save`} onRetry={retry} />
      </div>
      <div
        className={
          pending
            ? 'flex h-[34px] items-center rounded-control border border-border-subtle bg-bg-inset px-rc-xs text-small text-text-tertiary'
            : origin === 'override'
              ? 'flex h-[34px] items-center rounded-control border border-border-strong px-rc-xs text-small font-medium text-text-primary'
              : 'flex h-[34px] items-center rounded-control border border-border-subtle bg-bg-surface px-rc-xs text-small text-text-primary'
        }
      >
        <CustomSelect
          ariaLabel={label}
          options={selectOptions}
          value={value}
          onCommit={handleCommit}
          disabled={pending}
          valueClassName="text-text-primary"
          trailing={
            pending ? (
              <Spinner className="h-[11px] w-[11px]" thickness={1.3} />
            ) : (
              <>
                {origin === 'auto' && (
                  <span
                    title="AI chose this."
                    className="flex-none rounded-badge bg-bg-inset px-[6px] py-[1px] text-mono uppercase tracking-[0.06em] text-text-tertiary"
                  >
                    auto
                  </span>
                )}
                {origin === 'derived' && (
                  <span
                    title="Taken from your visual description."
                    className="flex-none rounded-badge bg-bg-inset px-[6px] py-[1px] text-mono uppercase tracking-[0.06em] text-text-tertiary"
                  >
                    described
                  </span>
                )}
                {origin === 'override' && (
                  <span
                    title="You picked this. It stays until you reset it."
                    className="flex-none rounded-badge bg-bg-inset px-[6px] py-[1px] text-mono uppercase tracking-[0.06em] text-text-tertiary"
                  >
                    set by you
                  </span>
                )}
              </>
            )
          }
        />
      </div>
      {!pending && origin === 'derived' && (
        <span className="text-meta text-text-tertiary">
          Derived from your description{showSettledNote && ` · was ${formatValue(previousValue ?? null)}`}
        </span>
      )}
      {!pending && origin === 'override' && (
        <button
          type="button"
          onClick={onRevert}
          className="flex cursor-pointer items-center gap-[5px] text-meta text-accent hover:underline"
        >
          <RevertIcon />
          Reset to auto
        </button>
      )}
    </div>
  )
}

export const CameraOriginFields = memo(function CameraOriginFields({
  shotId,
  shotSize,
  shotSizeOrigin,
  cameraAngle,
  cameraAngleOrigin,
  cameraMovement,
  cameraMovementOrigin,
  pendingFields,
  previousValues,
  justSettled,
  onFieldSaved,
  onFieldStatusChange,
  onRevert,
}: {
  shotId: string
  shotSize: string | null
  shotSizeOrigin: CameraOrigin
  cameraAngle: string | null
  cameraAngleOrigin: CameraOrigin
  cameraMovement: string | null
  cameraMovementOrigin: CameraOrigin
  pendingFields: Set<CameraFieldName>
  previousValues: Partial<Record<CameraFieldName, string | null>>
  justSettled: boolean
  onFieldSaved: (field: CameraFieldName, value: string) => void
  onFieldStatusChange: (key: string, status: FieldSaveStatus, retry: () => void) => void
  onRevert: (field: CameraFieldName) => void
}) {
  return (
    <div className="grid grid-cols-3 gap-rc-sm">
      <CameraField
        label="Shot size"
        options={SHOT_SIZES}
        value={shotSize}
        origin={shotSizeOrigin}
        pending={pendingFields.has('shot_size')}
        previousValue={previousValues.shot_size}
        justSettled={justSettled}
        formatValue={shotSizeLabel}
        save={(value) => updateShotSize(shotId, value)}
        onSaved={(value) => onFieldSaved('shot_size', value)}
        onStatusChange={(status, retry) => onFieldStatusChange('shot_size', status, retry)}
        onRevert={() => onRevert('shot_size')}
      />
      <CameraField
        label="Camera angle"
        options={CAMERA_ANGLES}
        value={cameraAngle}
        origin={cameraAngleOrigin}
        pending={pendingFields.has('camera_angle')}
        previousValue={previousValues.camera_angle}
        justSettled={justSettled}
        formatValue={cameraAngleLabel}
        save={(value) => updateShotCameraAngle(shotId, value)}
        onSaved={(value) => onFieldSaved('camera_angle', value)}
        onStatusChange={(status, retry) => onFieldStatusChange('camera_angle', status, retry)}
        onRevert={() => onRevert('camera_angle')}
      />
      <CameraField
        label="Camera movement"
        options={CAMERA_MOVEMENTS}
        value={cameraMovement}
        origin={cameraMovementOrigin}
        pending={pendingFields.has('camera_movement')}
        previousValue={previousValues.camera_movement}
        justSettled={justSettled}
        formatValue={cameraMovementLabel}
        save={(value) => updateShotCameraMovement(shotId, value)}
        onSaved={(value) => onFieldSaved('camera_movement', value)}
        onStatusChange={(status, retry) => onFieldStatusChange('camera_movement', status, retry)}
        onRevert={() => onRevert('camera_movement')}
      />
    </div>
  )
})
