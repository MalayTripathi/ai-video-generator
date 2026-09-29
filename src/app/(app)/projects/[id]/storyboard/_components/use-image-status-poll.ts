'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { parseRailFigures, useRailFigures } from '@/components/rail-figures-context'
import { isInFlight } from '@/lib/storyboard/timeline'
import { useSignedUrlRefresh } from '../../workbench/_components/use-signed-url-refresh'
import type { ImageStatusData } from './types'

// Polls the images status endpoint while any frame is queued or generating (or the
// voiceover or music is being made - its state rides on the same response, one poll for both), at the
// interval the endpoint itself names, and stops the moment none is. `refresh()` fetches at
// once - every action calls it, which also restarts the chain. Client state only: nothing
// here touches the router. When a poll shows a shot that was in flight has settled, the
// rail's spend figures (carried on every status response) are pushed to the rail store -
// a settle is when an image's charge lands.
// What the lane reads when a response carries no voiceover block at all.
export const NO_VOICEOVER: ImageStatusData['voiceover'] = {
  state: 'none',
  mode: null,
  startedAt: null,
  failedAt: null,
  attemptVoiceId: null,
  attemptChars: null,
  attemptDurationSec: null,
  retryUpload: null,
  current: null,
}

export const NO_MUSIC: ImageStatusData['music'] = {
  state: 'none',
  startedAt: null,
  failedAt: null,
  attemptSec: null,
  current: null,
}

export function useImageStatusPoll(projectId: string, initial: ImageStatusData) {
  const [data, setData] = useState(initial)
  const { setFigures } = useRailFigures()
  const inFlightIds = useRef(new Set(initial.shots.filter((s) => isInFlight(s.state)).map((s) => s.shotId)))
  const voiceoverInFlight = useRef(initial.voiceover.state === 'generating')
  const musicInFlight = useRef(initial.music.state === 'generating')
  // Bumped on a failed poll so the chain re-arms instead of silently stopping.
  const [failures, setFailures] = useState(0)
  const controllers = useRef(new Set<AbortController>())

  // Responses can land out of order (a slow read started before an edit, a fast one after
  // it); only the newest request's answer is ever applied.
  const latestRequest = useRef(0)

  const refresh = useCallback(async () => {
    const controller = new AbortController()
    controllers.current.add(controller)
    const requestNo = ++latestRequest.current
    try {
      const res = await fetch(`/api/projects/${projectId}/images/status`, {
        cache: 'no-store',
        signal: controller.signal,
      })
      const body = await res.json().catch(() => null)
      if (requestNo !== latestRequest.current) return
      if (!res.ok || !body?.ok) {
        setFailures((n) => n + 1)
        return
      }
      const shots = body.shots as ImageStatusData['shots']
      const voiceover = (body.voiceover as ImageStatusData['voiceover'] | undefined) ?? NO_VOICEOVER
      const music = (body.music as ImageStatusData['music'] | undefined) ?? NO_MUSIC
      const voiceoverSettled = voiceoverInFlight.current && voiceover.state !== 'generating'
      const musicSettled = musicInFlight.current && music.state !== 'generating'
      const settled =
        voiceoverSettled || musicSettled || shots.some((s) => inFlightIds.current.has(s.shotId) && !isInFlight(s.state))
      inFlightIds.current = new Set(shots.filter((s) => isInFlight(s.state)).map((s) => s.shotId))
      voiceoverInFlight.current = voiceover.state === 'generating'
      musicInFlight.current = music.state === 'generating'
      const rail = parseRailFigures(body.rail)
      if (settled && rail) setFigures(rail)
      setData({
        shots,
        voiceover,
        music,
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

  const polling =
    data.shots.some((s) => isInFlight(s.state)) ||
    data.voiceover.state === 'generating' ||
    data.music.state === 'generating'

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
