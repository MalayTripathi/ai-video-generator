'use client'

import { useCallback, useEffect, useRef, useState } from 'react'

export type FieldSaveStatus = 'idle' | 'saving' | 'saved' | 'failed'

type SaveOutcome = { success: boolean; unchanged?: boolean; error?: string }

const SAVED_DECAY_MS = 2000

// Shared per-field save lifecycle: saving -> saved (decays to idle after 2s) or failed
// (stays until retried). No Save button anywhere in this codebase's per-field editing -
// this hook is what "saves independently the moment the person leaves it" runs on.
// The field stays editable throughout - callers must never disable an input based on
// `status === 'saving'`. Callers that need to bubble status (and a retry handle) up to
// a card-level rollup do so themselves via an effect on the returned `status`/`retry` -
// keeping that concern out of the hook avoids an ordering dependency between the two.
export function useFieldSave() {
  const [status, setStatus] = useState<FieldSaveStatus>('idle')
  const [error, setError] = useState<string | null>(null)
  const requestIdRef = useRef(0)
  const decayTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const lastSaveRef = useRef<(() => Promise<SaveOutcome>) | null>(null)

  const updateStatus = useCallback((next: FieldSaveStatus) => {
    setStatus(next)
  }, [])

  useEffect(() => {
    return () => {
      if (decayTimerRef.current) clearTimeout(decayTimerRef.current)
    }
  }, [])

  const run = useCallback(
    async (save: () => Promise<SaveOutcome>) => {
      const requestId = ++requestIdRef.current
      lastSaveRef.current = save
      if (decayTimerRef.current) clearTimeout(decayTimerRef.current)
      updateStatus('saving')

      let result: SaveOutcome
      try {
        result = await save()
      } catch {
        result = { success: false, error: 'Save failed' }
      }

      // A newer save has already started (or finished) - this response is stale and
      // must not clobber status the newer one already set.
      if (requestId !== requestIdRef.current) return

      if (!result.success) {
        setError(result.error ?? 'Save failed')
        updateStatus('failed')
        return
      }

      setError(null)
      if (result.unchanged) {
        updateStatus('idle')
        return
      }
      updateStatus('saved')
      decayTimerRef.current = setTimeout(() => updateStatus('idle'), SAVED_DECAY_MS)
    },
    [updateStatus]
  )

  const retry = useCallback(() => {
    if (lastSaveRef.current) void run(lastSaveRef.current)
  }, [run])

  return { status, error, run, retry }
}
