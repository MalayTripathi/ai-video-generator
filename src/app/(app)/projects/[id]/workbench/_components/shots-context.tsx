'use client'

import { useRouter } from 'next/navigation'
import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import type { DisplayShot } from './types'
import { derivePhase, type Phase } from './derive-phase'
import { stepIndex } from '@/lib/config/pipeline'
import { usePageVisible } from '@/lib/hooks/use-page-visible'
import { SHOT_STATUS_POLL_MS } from '@/lib/config/shots'
import type { ShotRunView } from './shot-run-view'

type ShotsContextValue = {
  projectId: string
  shots: DisplayShot[]
  phase: Phase
  videoType: string | null
  videoModel: string | null
  hasPendingPayload: boolean
  shotListCredits: number
  // The latest shot run: progress while writing, why it stopped, what is left.
  run: ShotRunView
  // Set when the server refused a start for credits (402) - the prior state is untouched.
  startError: { requiredCredits: number; balanceCredits: number } | null
  confirmOpen: boolean
  // Which action the confirm modal is for: a fresh shot list, or only the unwritten scenes.
  confirmMode: 'regenerate' | 'remaining'
  openRetryConfirm: () => void
  openRemainingConfirm: () => void
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

// Exported (not just the throwing useShots() hook below) so a shared shell
// component like AgentPanel can read it optionally, without requiring a
// ShotsProvider ancestor on every step's page - see agent-panel.tsx.
export const ShotsContext = createContext<ShotsContextValue | null>(null)

export function ShotsProvider({
  projectId,
  initialShots,
  initialVideoType,
  initialVideoModel,
  initialGenerationState,
  initialHasPendingPayload,
  initialFurthestStep,
  initialRun,
  shotListCredits,
  children,
}: {
  projectId: string
  initialShots: DisplayShot[]
  initialVideoType: string | null
  initialVideoModel: string | null
  initialGenerationState: string | null
  initialHasPendingPayload: boolean
  initialFurthestStep: number
  initialRun: ShotRunView
  shotListCredits: number
  children: ReactNode
}) {
  const router = useRouter()
  const [shots, setShots] = useState(initialShots)
  const [videoType, setVideoType] = useState(initialVideoType)
  const [generationState, setGenerationState] = useState(initialGenerationState)
  const [hasPendingPayload, setHasPendingPayload] = useState(initialHasPendingPayload)
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [confirmMode, setConfirmMode] = useState<'regenerate' | 'remaining'>('regenerate')
  const [run, setRun] = useState(initialRun)
  const [startError, setStartError] = useState<{ requiredCredits: number; balanceCredits: number } | null>(null)
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

  // The run itself is server-side and self-continuing: a 202 means it started, and the
  // generating state's poll follows it. Closing the tab does not stop it.
  async function fetchShots(kind: 'trigger' | 'retry' | 'remaining') {
    const previousState = generationState
    try {
      const response = await fetch(`/api/projects/${projectId}/shots`, {
        method: 'POST',
        ...(kind === 'trigger'
          ? {}
          : {
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(kind === 'remaining' ? { remaining: true } : { retry: true }),
            }),
      })
      if (response.status === 402) {
        // Refused before anything began - the prior state stands.
        const body = (await response.json()) as { requiredCredits: number; balanceCredits: number }
        setStartError({ requiredCredits: body.requiredCredits, balanceCredits: body.balanceCredits })
        setGenerationState(previousState)
        return
      }
      setStartError(null)
      // Whatever the outcome (202, 409, 422, 500), the DB row is the source of truth -
      // resync from the server rather than hand-deriving the new status here.
      router.refresh()
    } catch {
      // A genuine network failure (e.g. offline) never reached the server, so there is
      // nothing to resync - fall back to a local failed status.
      setGenerationState('failed')
    }
  }

  function openRetryConfirm() {
    setConfirmMode('regenerate')
    setConfirmOpen(true)
  }

  function openRemainingConfirm() {
    setConfirmMode('remaining')
    setConfirmOpen(true)
  }

  function closeRetryConfirm() {
    setConfirmOpen(false)
  }

  function confirmRetry() {
    setConfirmOpen(false)
    setGenerationState('generating')
    void fetchShots(confirmMode === 'remaining' ? 'remaining' : 'retry')
  }

  useEffect(() => {
    if (triggeredRef.current) return
    if (phase !== 'trigger') return
    triggeredRef.current = true
    // Fire-once trigger for shot generation on first load. Optimistically flips to
    // 'generating' so the skeleton shows immediately, before the POST resolves.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setGenerationState('generating')
    void fetchShots('trigger')
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
    setRun(initialRun)
    // A real refresh cycle has now landed - safe for any field waiting on
    // touchedShotKeys to apply the (now current) value it's holding. See
    // refreshPending's own comment above.
    setRefreshPending(false)
  }, [initialShots, initialVideoType, initialGenerationState, initialHasPendingPayload, initialRun])

  // Poll while generating - a tab that never fired its own POST (loaded mid-generation, or
  // on another device) follows the run too. Each poll is a lightweight status read (never
  // router.refresh(), which re-renders the layout and page); the next starts only after the
  // previous returns. When the claim has settled the page refreshes once for the finished
  // list. Paused while the tab is hidden; polls at once on return. The first poll otherwise
  // waits an interval, so it never reads a retried claim's old 'failed' before the POST
  // has reclaimed it.
  const resumedRef = useRef(false)
  const visible = usePageVisible(() => {
    resumedRef.current = true
  })
  useEffect(() => {
    if (phase !== 'generating' || !visible) return
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const poll = async () => {
      try {
        const response = await fetch(`/api/projects/${projectId}/shots/status`, { cache: 'no-store' })
        if (cancelled) return
        if (response.ok) {
          const status = (await response.json()) as { generationState: string | null; run: ShotRunView }
          if (cancelled) return
          setRun(status.run)
          if (status.generationState === 'succeeded' || status.generationState === 'failed') {
            router.refresh()
            return
          }
        }
      } catch {
        // A dropped poll is retried on the next tick.
      }
      if (!cancelled) timer = setTimeout(poll, SHOT_STATUS_POLL_MS)
    }
    timer = setTimeout(poll, resumedRef.current ? 0 : SHOT_STATUS_POLL_MS)
    resumedRef.current = false
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [phase, visible, projectId, router])

  return (
    <ShotsContext.Provider
      value={{
        projectId,
        shots,
        phase,
        videoType,
        videoModel,
        hasPendingPayload,
        shotListCredits,
        run,
        startError,
        confirmOpen,
        confirmMode,
        openRetryConfirm,
        openRemainingConfirm,
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
