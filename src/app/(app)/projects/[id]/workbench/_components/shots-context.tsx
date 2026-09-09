'use client'

import { useRouter } from 'next/navigation'
import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import type { DisplayShot } from './types'
import { derivePhase, type Phase } from './derive-phase'
import { stepIndex } from '@/lib/config/pipeline'

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
  removeShotLocal: (shotId: string) => void
  // Read-only workbench: true once furthest_step has reached storyboard. furthest_step
  // never changes client-side (no advanceStep() caller exists yet), so this is computed
  // once from the initial value rather than kept in its own resync effect.
  readOnly: boolean
  // Per-tool-call shot locking for an in-flight agent turn - see docs/decisions.md
  // ("C4 streaming"). Keyed by shot_key (the server's stable identifier, present only
  // on a tool_completed/refusal that names one specific shot - update_shot/insert_shot,
  // never get_shot/regenerate_all_shots). Locking is deliberately scoped to exactly
  // those events; there is nothing to lock for a tool with no shotKey.
  lockedShotKeys: Set<string>
  lockShot: (shotKey: string) => void
  unlockAllShots: () => void
  // Shots (by shot_key) an update_shot/insert_shot tool call touched this turn, to be
  // resynced from the next server refresh even for an already-expanded card whose field
  // components hold their own local draft state (a plain prop change never overwrites
  // that - see visual-description-field.tsx and friends). regenerate_all_shots needs no
  // equivalent: it deletes and reinserts every shot with brand-new ids, so the refresh
  // remounts those cards outright (new React key) instead of updating them in place -
  // there is no local draft to protect on a component that never existed before.
  touchedShotKeys: Set<string>
  refreshPending: boolean
  markShotsTouched: (shotKeys: string[]) => void
  consumeTouchedShot: (shotKey: string) => void
  // Accordion: at most one shot card expanded at a time (canvas: "Only one card is
  // expanded at a time"). Lives here rather than per-card local state so expanding one
  // card can coordinate collapsing whichever other card was open.
  expandedShotId: string | null
  expandShot: (shotId: string) => void
  collapseShot: () => void
}

const ShotsContext = createContext<ShotsContextValue | null>(null)

export function ShotsProvider({
  projectId,
  initialShots,
  initialVideoType,
  initialVideoModel,
  initialGenerationState,
  initialHasPendingPayload,
  initialFurthestStep,
  estimatedCredits,
  children,
}: {
  projectId: string
  initialShots: DisplayShot[]
  initialVideoType: string | null
  initialVideoModel: string | null
  initialGenerationState: string | null
  initialHasPendingPayload: boolean
  initialFurthestStep: number
  estimatedCredits: number
  children: ReactNode
}) {
  const router = useRouter()
  const [shots, setShots] = useState(initialShots)
  const [videoType, setVideoType] = useState(initialVideoType)
  const [generationState, setGenerationState] = useState(initialGenerationState)
  const [hasPendingPayload, setHasPendingPayload] = useState(initialHasPendingPayload)
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [lockedShotKeys, setLockedShotKeys] = useState<Set<string>>(new Set())
  const [touchedShotKeys, setTouchedShotKeys] = useState<Set<string>>(new Set())
  // True from the moment an agent turn names touched shots until the router.refresh()
  // it triggers actually lands (the "sync from server" effect below runs). Without this,
  // a field's external-resync effect fires as soon as touchedShotKeys flips true - before
  // the refreshed value has arrived - applies the still-stale prop, and immediately
  // consumes the touch, permanently missing the real value that lands moments later. See
  // use-external-resync.ts.
  const [refreshPending, setRefreshPending] = useState(false)
  const [expandedShotId, setExpandedShotId] = useState<string | null>(null)
  const triggeredRef = useRef(false)
  const readOnly = initialFurthestStep >= stepIndex('storyboard')

  // video_model isn't edited anywhere in this task - passed through statically rather
  // than kept in its own useState.
  const videoModel = initialVideoModel

  function updateShotLocal(shotId: string, patch: Partial<DisplayShot>) {
    setShots((prev) => prev.map((shot) => (shot.id === shotId ? { ...shot, ...patch } : shot)))
  }

  function removeShotLocal(shotId: string) {
    setShots((prev) => prev.filter((shot) => shot.id !== shotId))
  }

  // Overwriting expandedShotId (rather than toggling) is what makes this an accordion -
  // whichever card held it is implicitly collapsed the instant a different one expands.
  function expandShot(shotId: string) {
    setExpandedShotId(shotId)
  }

  function collapseShot() {
    setExpandedShotId(null)
  }

  function lockShot(shotKey: string) {
    setLockedShotKeys((prev) => new Set(prev).add(shotKey))
  }

  function unlockAllShots() {
    setLockedShotKeys(new Set())
  }

  function markShotsTouched(shotKeys: string[]) {
    if (shotKeys.length === 0) return
    setTouchedShotKeys((prev) => {
      const next = new Set(prev)
      for (const key of shotKeys) next.add(key)
      return next
    })
    setRefreshPending(true)
  }

  function consumeTouchedShot(shotKey: string) {
    setTouchedShotKeys((prev) => {
      if (!prev.has(shotKey)) return prev
      const next = new Set(prev)
      next.delete(shotKey)
      return next
    })
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
    // A real refresh cycle has now landed - safe for any field waiting on
    // touchedShotKeys to apply the (now current) value it's holding. See
    // refreshPending's own comment above.
    setRefreshPending(false)
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
        removeShotLocal,
        readOnly,
        lockedShotKeys,
        lockShot,
        unlockAllShots,
        touchedShotKeys,
        refreshPending,
        markShotsTouched,
        consumeTouchedShot,
        expandedShotId,
        expandShot,
        collapseShot,
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
