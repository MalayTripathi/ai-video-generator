'use client'

import { memo, useEffect, useState } from 'react'
import { resolveVideoModel, isDurationAllowed } from '@/lib/config/models'
import { updateShotDuration } from '../actions'
import { SaveStatusIndicator } from './save-status-indicator'
import { useShots } from './shots-context'
import { useFieldSave, type FieldSaveStatus } from './use-field-save'

function WarningTriangle() {
  return (
    <svg width="11" height="10" viewBox="0 0 12 11" fill="none" aria-hidden="true" className="flex-none">
      <path d="M6 1 11.2 10H0.8L6 1z" stroke="currentColor" strokeWidth="1.1" strokeLinejoin="round" />
      <path d="M6 4.3v2.6" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" />
    </svg>
  )
}

const STEP = 0.1

function round1(n: number) {
  return Math.round(n * 10) / 10
}

// "5s or 10s" / "5s" / "5s, 7s, or 10s" - never a range phrase ("between 5 and 10
// seconds") for a discrete model, since that would be actively false: a discrete model
// only renders its exact allowed values, nothing between them.
function formatAllowedDurations(sorted: number[]): string {
  const formatted = sorted.map((v) => `${v}s`)
  if (formatted.length === 1) return formatted[0]
  if (formatted.length === 2) return `${formatted[0]} or ${formatted[1]}`
  return `${formatted.slice(0, -1).join(', ')}, or ${formatted[formatted.length - 1]}`
}

// Continuous: 0.1s steps, always one decimal on display (5 -> "5.0s"), clamped to the
// model's durationMin/durationMax. Discrete: steps land on the model's exact allowed
// values only - handleStep finds the next/previous allowed value rather than adding a
// fixed delta, so it can never produce an intermediate value. Bounds/allowed values
// come from the project's selected video model, never a fixed constant. A saved value
// the current model can't render (reachable when the project's model changes after
// durations were locked, or - for a discrete model - was always invalid) is amber and
// never silently rewritten - only the person can bring it back in range, one press at a
// time; see `handleStep`'s asymmetric clamping/nearest-neighbor logic below.
export const DurationStepper = memo(function DurationStepper({
  shotId,
  durationSec,
  onStatusChange,
}: {
  shotId: string
  durationSec: number | null
  onStatusChange: (status: FieldSaveStatus, retry: () => void) => void
}) {
  const { videoModel, updateShotLocal } = useShots()
  const modelConfig = resolveVideoModel(videoModel)
  const { status, run, retry } = useFieldSave()

  const [value, setValue] = useState(durationSec)

  useEffect(() => {
    onStatusChange(status, retry)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status])

  if (!modelConfig) {
    return (
      <div className="flex flex-col gap-rc-2xs">
        <span className="text-label font-medium uppercase leading-4 tracking-label text-text-tertiary">Duration</span>
        <span className="text-meta text-text-tertiary">Duration bounds unavailable for this project&rsquo;s model.</span>
      </div>
    )
  }

  const { label } = modelConfig
  const isDiscreteModel = modelConfig.kind === 'discrete'
  const sortedAllowed = modelConfig.kind === 'discrete' ? [...modelConfig.allowedDurations].sort((a, b) => a - b) : []
  const durationMin = modelConfig.kind === 'continuous' ? modelConfig.durationMin : sortedAllowed[0]
  const durationMax = modelConfig.kind === 'continuous' ? modelConfig.durationMax : sortedAllowed[sortedAllowed.length - 1]

  const isUnset = value === null
  const displayValue = value ?? durationMin
  const isOutOfRange = value !== null && !isDurationAllowed(modelConfig, value)
  const canDecrement = isDiscreteModel ? sortedAllowed.some((v) => v < displayValue) : displayValue > durationMin
  const canIncrement = isDiscreteModel ? sortedAllowed.some((v) => v > displayValue) : displayValue < durationMax

  function commit(next: number) {
    setValue(next)
    void run(async () => {
      const result = await updateShotDuration(shotId, next)
      if (result.success) {
        updateShotLocal(shotId, { duration_sec: next, duration_locked: true })
      }
      return result
    })
  }

  function handleStep(direction: 1 | -1) {
    let next: number | null
    if (isDiscreteModel) {
      // Nearest allowed neighbor in the direction of travel - this is what makes a
      // click from an out-of-range value (e.g. 7.3s on a 5/10 model) land straight on
      // the nearest real value instead of an intermediate one.
      const candidates =
        direction > 0 ? sortedAllowed.filter((v) => v > displayValue) : sortedAllowed.filter((v) => v < displayValue)
      next = candidates.length === 0 ? null : direction > 0 ? Math.min(...candidates) : Math.max(...candidates)
    } else {
      // Clamp only at the bound in the direction of travel, so a value currently
      // outside the range moves back toward it one press at a time rather than
      // snapping there.
      const raw = round1(displayValue + direction * STEP)
      next = direction < 0 ? Math.max(raw, durationMin) : Math.min(raw, durationMax)
    }
    // Compared against displayValue (synchronous local state), not persisted (only
    // updated once the async save resolves) - comparing against persisted here would
    // race a fast double-click: a second step fired before the first's save round trip
    // completes would read a stale persisted value and silently no-op instead of
    // committing the new step.
    if (next === null || next === displayValue) return
    commit(next)
  }

  let helperText: string
  if (isUnset) {
    helperText = `Not yet set — Step 3 will time this automatically.`
  } else if (isOutOfRange && isDiscreteModel) {
    const allowedList = formatAllowedDurations(sortedAllowed)
    helperText = `${displayValue.toFixed(1)}s isn't a duration ${label} renders — it renders ${allowedList} clips. Nothing has been changed for you. Pick ${allowedList}, or a model that can hold ${displayValue.toFixed(1)}s.`
  } else if (isOutOfRange && displayValue > durationMax) {
    helperText = `${displayValue.toFixed(1)}s is longer than ${label} allows — it takes ${durationMin}s to ${durationMax}s. Nothing has been changed for you. Bring it down to ${durationMax}s, or pick a model that can hold ${displayValue.toFixed(1)}s.`
  } else if (isOutOfRange) {
    helperText = `${displayValue.toFixed(1)}s is shorter than ${label} allows — it takes ${durationMin}s to ${durationMax}s. Nothing has been changed for you. Bring it up to ${durationMin}s, or pick a model that can hold ${displayValue.toFixed(1)}s.`
  } else if (!canDecrement) {
    helperText = `${durationMin}s is the shortest clip ${label} renders.`
  } else if (!canIncrement) {
    helperText = `${durationMax}s is the longest clip ${label} renders.`
  } else if (isDiscreteModel) {
    helperText = `${label} renders ${formatAllowedDurations(sortedAllowed)} clips.`
  } else {
    helperText = `${label} takes ${durationMin}s to ${durationMax}s, in tenths.`
  }

  return (
    <div className="flex flex-col gap-rc-2xs">
      <div className="flex min-h-4 items-center justify-between gap-rc-xs">
        <span className="text-label font-medium uppercase leading-4 tracking-label text-text-tertiary">Duration</span>
        <SaveStatusIndicator status={status} label="Duration didn't save" onRetry={retry} />
      </div>
      <div
        className={`flex w-fit items-center gap-rc-2xs rounded-control border p-[1px] ${
          isOutOfRange ? 'border-status-active-fg bg-status-active-bg' : 'border-border-subtle bg-bg-surface'
        }`}
      >
        <button
          type="button"
          aria-label="Decrease duration"
          disabled={!canDecrement}
          onClick={() => handleStep(-1)}
          className={`flex h-8 w-8 cursor-pointer items-center justify-center rounded-badge text-text-primary disabled:cursor-not-allowed disabled:bg-bg-inset disabled:text-text-quiet ${
            isOutOfRange ? 'hover:bg-status-active-bg-hover' : 'hover:bg-bg-inset'
          }`}
        >
          −
        </button>
        <span
          data-testid="duration-value"
          className={`w-[52px] text-center font-mono text-small ${
            isOutOfRange ? 'font-medium text-banner-active-title' : isUnset ? 'text-text-tertiary' : 'text-text-primary'
          }`}
        >
          {displayValue.toFixed(1)}s
        </span>
        <button
          type="button"
          aria-label="Increase duration"
          disabled={!canIncrement}
          onClick={() => handleStep(1)}
          className={`flex h-8 w-8 cursor-pointer items-center justify-center rounded-badge text-text-primary disabled:cursor-not-allowed disabled:bg-bg-inset disabled:text-text-quiet ${
            isOutOfRange ? 'hover:bg-status-active-bg-hover' : 'hover:bg-bg-inset'
          }`}
        >
          +
        </button>
      </div>
      <span className={`flex items-start gap-[5px] text-meta ${isOutOfRange ? 'text-status-active-fg' : 'text-text-tertiary'}`}>
        {isOutOfRange && <WarningTriangle />}
        {helperText}
      </span>
    </div>
  )
})
