'use client'

import { useRef, useState } from 'react'
import { CAMERA_FIELD_NAMES, type CameraFieldName } from '@/lib/prompts/camera-derivation'

export type CameraDerivationStatusValue = 'idle' | 'running' | 'succeeded' | 'failed'

export type CameraFieldUpdate = { value: string; origin: 'auto' | 'derived' }

type DerivationRequest = { fields?: CameraFieldName[]; revertField?: CameraFieldName }

/**
 * One instance per ShotCard (= per shot) - the correct guard granularity, since the
 * harness never mounts two ShotCards for the same shot concurrently, so no
 * shotId-keyed map is needed.
 *
 * The in-flight guard COALESCES rather than drops: a trigger that arrives while one is
 * already running replaces any already-queued trigger (so at most one is ever waiting)
 * and fires automatically once the running call finishes. Dropping was rejected because
 * a dropped "Revert to auto" click would leave a field on 'override' with no feedback -
 * see CLAUDE.md. This deliberately allows up to 2 billed calls for 2 rapid *distinct*
 * edits, never more than 2 regardless of how many times a trigger re-fires while one is
 * already running (repeated re-fires just keep replacing the single queued slot).
 *
 * `runOne`/`trigger`/`retry` are deliberately plain functions, not manually wrapped in
 * useCallback - runOne calls itself recursively in its own `finally` block to run a
 * coalesced pending request, and the React Compiler cannot preserve manual memoization
 * across that kind of self-reference. Nothing here depends on these functions having a
 * stable identity across renders (they're only ever called imperatively, never used as
 * an effect dependency), so there's nothing to lose by leaving them unmemoized.
 */
export function useCameraDerivation(projectId: string, shotId: string) {
  const [status, setStatus] = useState<CameraDerivationStatusValue>('idle')
  const [pendingFields, setPendingFields] = useState<Set<CameraFieldName>>(new Set())
  const runningRef = useRef(false)
  const queuedRef = useRef<DerivationRequest | null>(null)
  const lastRequestRef = useRef<DerivationRequest | null>(null)

  async function runOne(
    request: DerivationRequest
  ): Promise<Partial<Record<CameraFieldName, CameraFieldUpdate>> | undefined> {
    runningRef.current = true
    lastRequestRef.current = request
    const activeFields = request.fields ?? (request.revertField ? [request.revertField] : [...CAMERA_FIELD_NAMES])
    setStatus('running')
    setPendingFields(new Set(activeFields))

    let updated: Partial<Record<CameraFieldName, CameraFieldUpdate>> | undefined
    try {
      const response = await fetch(`/api/projects/${projectId}/shots/${shotId}/camera`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(request),
      })
      if (!response.ok) {
        setStatus('failed')
        return undefined
      }
      const data = await response.json()
      setStatus('succeeded')
      updated = data.updated
      return updated
    } catch {
      setStatus('failed')
      return undefined
    } finally {
      runningRef.current = false
      setPendingFields(new Set())
      const next = queuedRef.current
      queuedRef.current = null
      if (next) void runOne(next)
    }
  }

  function trigger(request: DerivationRequest) {
    if (runningRef.current) {
      queuedRef.current = request
      return Promise.resolve(undefined)
    }
    return runOne(request)
  }

  function retry() {
    return trigger(lastRequestRef.current ?? { fields: [...CAMERA_FIELD_NAMES] })
  }

  return { status, pendingFields, trigger, retry }
}
