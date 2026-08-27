'use client'

import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import type { DisplayShot } from './types'

type Phase = 'idle' | 'generating' | 'failed'

type ShotsContextValue = {
  shots: DisplayShot[]
  phase: Phase
  videoType: string | null
  retry: () => void
}

const ShotsContext = createContext<ShotsContextValue | null>(null)

export function ShotsProvider({
  projectId,
  initialShots,
  initialVideoType,
  children,
}: {
  projectId: string
  initialShots: DisplayShot[]
  initialVideoType: string | null
  children: ReactNode
}) {
  const [shots, setShots] = useState(initialShots)
  const [videoType, setVideoType] = useState(initialVideoType)
  const [phase, setPhase] = useState<Phase>(initialShots.length === 0 ? 'generating' : 'idle')
  const triggeredRef = useRef(false)

  async function fetchShots() {
    try {
      const response = await fetch(`/api/projects/${projectId}/shots`, { method: 'POST' })
      if (response.status === 409) {
        // Another generation is already running for this project - the CAS
        // lock is the source of truth here, not the client. No polling: the
        // lock self-heals after 3 minutes if the other request died.
        return
      }
      if (!response.ok) {
        setPhase('failed')
        return
      }
      const data = await response.json()
      setShots(data.shots)
      setVideoType(data.video_type)
      setPhase('idle')
    } catch {
      setPhase('failed')
    }
  }

  function retry() {
    setPhase('generating')
    void fetchShots()
  }

  useEffect(() => {
    if (triggeredRef.current) return
    if (initialShots.length > 0) return
    triggeredRef.current = true
    // Fire-once trigger for shot generation on first load. setState only
    // happens after the POST resolves, not synchronously in this effect.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void fetchShots()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <ShotsContext.Provider value={{ shots, phase, videoType, retry }}>{children}</ShotsContext.Provider>
  )
}

export function useShots() {
  const ctx = useContext(ShotsContext)
  if (!ctx) throw new Error('useShots must be used within a ShotsProvider')
  return ctx
}
