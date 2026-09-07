'use client'

import { useEffect, useState } from 'react'

/**
 * Resyncs a field's own local draft from an external value (an agent edit landing via
 * ShotsProvider's touchedShotKeys + a subsequent router.refresh()) - but only when this
 * field isn't currently focused. A field's local draft never resyncs from a plain prop
 * change on its own (see visual-description-field.tsx and friends - that's what already
 * protects a field mid-edit from an unrelated background refresh); this hook is the one
 * place that deliberately overrides that, gated on `isTouched` so it only fires for a
 * shot this exact turn actually changed. When focused, this is a no-op - the field simply
 * won't reflect the agent's edit until the user leaves it, at which point their own
 * blur-save (last-write-wins, same as any other concurrent edit) takes over.
 *
 * `refreshPending` (ShotsProvider's own flag) must also be false before this applies:
 * `isTouched` flips true the instant a turn settles, well before the router.refresh() it
 * triggers has actually landed new data - applying `externalValue` (and consuming the
 * touch) at that moment would use the still-stale prop and then never get another
 * chance, since consuming clears `isTouched` before the real value ever arrives. Waiting
 * for refreshPending to clear guarantees the fresh value and the touch flag are visible
 * together on the same render.
 */
export function useExternalResync<T>(
  externalValue: T,
  isTouched: boolean,
  refreshPending: boolean,
  apply: (value: T) => void,
  onConsumed: () => void
) {
  const [focused, setFocused] = useState(false)

  useEffect(() => {
    if (!isTouched || refreshPending || focused) return
    apply(externalValue)
    onConsumed()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [externalValue, isTouched, refreshPending, focused])

  return { focused, setFocused }
}
