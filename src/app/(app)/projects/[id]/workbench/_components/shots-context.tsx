'use client'

import { useRouter } from 'next/navigation'
import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import type { DisplayShot } from './types'
import { derivePhase, type Phase } from './derive-phase'

type ShotsContextValue = {
  projectId: string
  shots: DisplayShot[]
  phase: Phase
  videoType: string | null
  videoModel: string | null
  hasPendingPayload: boolean
  estimatedCredits: number
  confirmOpen: boolean
  openRetryConfirm: () => void
  closeRetryConfirm: () => void
  confirmRetry: () => void
  updateShotLocal: (shotId: string, patch: Partial<DisplayShot>) => void
}

const ShotsContext = createContext<ShotsContextValue | null>(null)

export function ShotsProvider({
  projectId,
  initialShots,
  initialVideoType,
  initialVideoModel,
  initialGenerationState,
  initialHasPendingPayload,
  estimatedCredits,
  children,
}: {
  projectId: string
  initialShots: DisplayShot[]
  initialVideoType: string | null
  initialVideoModel: string | null
  initialGenerationState: string | null
  initialHasPendingPayload: boolean
  estimatedCredits: number
  children: ReactNode
}) {
  const router = useRouter()
  const [shots, setShots] = useState(initialShots)
  const [videoType, setVideoType] = useState(initialVideoType)
  const [generationState, setGenerationState] = useState(initialGenerationState)
  const [hasPendingPayload, setHasPendingPayload] = useState(initialHasPendingPayload)
  const [confirmOpen, setConfirmOpen] = useState(false)
  const triggeredRef = useRef(false)

  // video_model isn't edited anywhere in this task - passed through statically rather
  // than kept in its own useState.
  const videoModel = initialVideoModel

  function updateShotLocal(shotId: string, patch: Partial<DisplayShot>) {
    setShots((prev) => prev.map((shot) => (shot.id === shotId ? { ...shot, ...patch } : shot)))
  }

  const phase = derivePhase({
    generation: generationState === null ? null : { state: generationState },
    shotCount: shots.length,
  })

  async function fetchShots(isRetry: boolean) {
    try {
      const response = await fetch(`/api/projects/${projectId}/shots`, {
        method: 'POST',
        ...(isRetry
          ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ retry: true }) }
          : {}),
      })
      if (response.ok) {
        const data = await response.json()
        setShots(data.shots)
        setVideoType(data.video_type)
      }
      // Whatever the outcome (success, 409, 422, 500), the DB row is the source of truth -
      // resync from the server rather than hand-deriving the new status here.
      router.refresh()
    } catch {
      // A genuine network failure (e.g. offline) never reached the server, so there is
      // nothing to resync - fall back to a local failed status.
      setGenerationState('failed')
    }
  }

  function openRetryConfirm() {
    setConfirmOpen(true)
  }

  function closeRetryConfirm() {
    setConfirmOpen(false)
  }

  function confirmRetry() {
    setConfirmOpen(false)
    setGenerationState('generating')
    void fetchShots(true)
  }

  useEffect(() => {
    if (triggeredRef.current) return
    if (phase !== 'trigger') return
    triggeredRef.current = true
    // Fire-once trigger for shot generation on first load. Optimistically flips to
    // 'generating' so the skeleton shows immediately, before the POST resolves.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setGenerationState('generating')
    void fetchShots(false)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Sync from the server whenever the parent server component re-renders (after a
  // router.refresh(), whether triggered by this tab's own request or a poll below) - this
  // is how a passive tab that never fired its own POST picks up another tab/device's result.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setShots(initialShots)
    setVideoType(initialVideoType)
    setGenerationState(initialGenerationState)
    setHasPendingPayload(initialHasPendingPayload)
  }, [initialShots, initialVideoType, initialGenerationState, initialHasPendingPayload])

  // Poll while generating so a tab that never fired its own POST (e.g. loaded mid-generation
  // from another tab/device) discovers completion. workbench/page.tsx is a server component
  // that re-reads the project row on every refresh - no separate GET route needed.
  useEffect(() => {
    if (phase !== 'generating') return
    const interval = setInterval(() => router.refresh(), 3000)
    return () => clearInterval(interval)
  }, [phase, router])

  return (
    <ShotsContext.Provider
      value={{
        projectId,
        shots,
        phase,
        videoType,
        videoModel,
        hasPendingPayload,
        estimatedCredits,
        confirmOpen,
        openRetryConfirm,
        closeRetryConfirm,
        confirmRetry,
        updateShotLocal,
      }}
    >
      {children}
    </ShotsContext.Provider>
  )
}

export function useShots() {
  const ctx = useContext(ShotsContext)
  if (!ctx) throw new Error('useShots must be used within a ShotsProvider')
  return ctx
}
