'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { parseRailFigures, useRailFigures } from '@/components/rail-figures-context'
import { isInFlight } from '@/lib/storyboard/timeline'
import { useSignedUrlRefresh } from '../../workbench/_components/use-signed-url-refresh'
import type { ImageStatusData } from './types'

// Polls the images status endpoint while any frame is queued or generating, at the
// interval the endpoint itself names, and stops the moment none is. `refresh()` fetches at
// once - every action calls it, which also restarts the chain. Client state only: nothing
// here touches the router. When a poll shows a shot that was in flight has settled, the
// rail's spend figures (carried on every status response) are pushed to the rail store -
// a settle is when an image's charge lands.
export function useImageStatusPoll(projectId: string, initial: ImageStatusData) {
  const [data, setData] = useState(initial)
  const { setFigures } = useRailFigures()
  const inFlightIds = useRef(new Set(initial.shots.filter((s) => isInFlight(s.state)).map((s) => s.shotId)))
  // Bumped on a failed poll so the chain re-arms instead of silently stopping.
  const [failures, setFailures] = useState(0)
  const controllers = useRef(new Set<AbortController>())

  const refresh = useCallback(async () => {
    const controller = new AbortController()
    controllers.current.add(controller)
    try {
      const res = await fetch(`/api/projects/${projectId}/images/status`, {
        cache: 'no-store',
        signal: controller.signal,
      })
      const body = await res.json().catch(() => null)
      if (!res.ok || !body?.ok) {
        setFailures((n) => n + 1)
        return
      }
      const shots = body.shots as ImageStatusData['shots']
      const settled = shots.some((s) => inFlightIds.current.has(s.shotId) && !isInFlight(s.state))
      inFlightIds.current = new Set(shots.filter((s) => isInFlight(s.state)).map((s) => s.shotId))
      const rail = parseRailFigures(body.rail)
      if (settled && rail) setFigures(rail)
      setData({
        shots,
        pollIntervalMs: body.pollIntervalMs,
        expiresAt: body.expiresAt,
        balanceCredits: body.balanceCredits,
      })
    } catch (err) {
      if ((err as { name?: string })?.name !== 'AbortError') setFailures((n) => n + 1)
    } finally {
      controllers.current.delete(controller)
    }
  }, [projectId, setFigures])

  const polling = data.shots.some((s) => isInFlight(s.state))

  // One timer per response: each new `data` (or failure) re-arms it, so the chain runs
  // exactly as long as something is in flight.
  useEffect(() => {
    if (!polling) return
    const timer = setTimeout(() => void refresh(), data.pollIntervalMs)
    return () => clearTimeout(timer)
  }, [polling, data, failures, refresh])

  useEffect(() => {
    const live = controllers.current
    return () => live.forEach((c) => c.abort())
  }, [])

  // An idle page (nothing polling) still re-signs before its URLs expire.
  useSignedUrlRefresh(data.expiresAt, refresh)

  return { data, polling, refresh }
}
