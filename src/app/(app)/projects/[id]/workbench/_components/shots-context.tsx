'use client'

import { useRouter } from 'next/navigation'
import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import type { DisplayShot } from './types'
import { derivePhase, type Phase } from './derive-phase'
import { stepIndex } from '@/lib/config/pipeline'
import { usePageVisible } from '@/lib/hooks/use-page-visible'
import { SHOT_STATUS_POLL_MS } from '@/lib/config/shots'
import { sameShotRunView, shotRunChargeLine, type ShotRunView } from './shot-run-view'
import { parseRailFigures, useRailFigures } from '@/components/rail-figures-context'
import type { AgentMessage } from '@/components/workbench/agent-message'
import type { RunElements } from '@/app/api/projects/[id]/shots/list/logic'

type ShotsContextValue = {
  projectId: string
  /** The project's title: the page's, then the one a run's outline sets (status checks). */
  title: string | null
  shots: DisplayShot[]
  phase: Phase
  videoType: string | null
  videoModel: string | null
  hasPendingPayload: boolean
  /** The hold a whole shot list places (credits.ts shotGenerationCredits). */
  shotListCredits: number
  /** The hold "Generate remaining shots" places (credits.ts remainingShotQuoteCredits). */
  remainingCredits: number
  /** The last settled run's "80 held · 62 charged", from the page's data - it changes only
   * when the page re-renders, so reading it never ties a component to the status checks. */
  chargeLine: string | null
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
  // What the last run this tab followed changed beyond the shot list, from its end-of-run
  // read: the Assets tab's elements and generate gate (applied by AssetsProvider), and the
  // messages the run wrote (appended by AgentPanel). Null / empty until a run ends here.
  runElements: RunElements | null
  runMessages: AgentMessage[]
}

// Exported (not just the throwing useShots() hook below) so a shared shell
// component like AgentPanel can read it optionally, without requiring a
// ShotsProvider ancestor on every step's page - see agent-panel.tsx.
export const ShotsContext = createContext<ShotsContextValue | null>(null)

export function ShotsProvider({
  projectId,
  initialTitle,
  initialShots,
  initialVideoType,
  initialVideoModel,
  initialGenerationState,
  initialHasPendingPayload,
  initialFurthestStep,
  initialRun,
  shotListCredits,
  remainingCredits,
  children,
}: {
  projectId: string
  initialTitle: string | null
  initialShots: DisplayShot[]
  initialVideoType: string | null
  initialVideoModel: string | null
  initialGenerationState: string | null
  initialHasPendingPayload: boolean
  initialFurthestStep: number
  initialRun: ShotRunView
  shotListCredits: number
  remainingCredits: number
  children: ReactNode
}) {
  const router = useRouter()
  const { setFigures } = useRailFigures()
  const [title, setTitle] = useState(initialTitle)
  const [runElements, setRunElements] = useState<RunElements | null>(null)
  const [runMessages, setRunMessages] = useState<AgentMessage[]>([])
  const [shots, setShots] = useState(initialShots)
  const [videoType, setVideoType] = useState(initialVideoType)
  const [generationState, setGenerationState] = useState(initialGenerationState)
  const [hasPendingPayload, setHasPendingPayload] = useState(initialHasPendingPayload)
  // The run's end state, from the page or - once a run this tab follows ends - from the
  // shot-list read that replaces a page render.
  const [endedRun, setEndedRun] = useState(initialRun)
  const [remaining, setRemaining] = useState(remainingCredits)
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [confirmMode, setConfirmMode] = useState<'regenerate' | 'remaining'>('regenerate')
  // The run a start from this tab created: 'pending' from the moment the request is sent
  // until it answers, so no status check reads a previous run's end as this one's.
  const [expectedRunId, setExpectedRunId] = useState<string | 'pending' | null>(null)
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
  // True while this tab's own start request is in flight: the server cannot know of that
  // run yet, so a server state read meanwhile never takes back the 'generating' it set.
  const startingRef = useRef(false)
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
    setExpectedRunId('pending')
    startingRef.current = true
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
      startingRef.current = false
      if (response.status === 402) {
        // Refused before anything began - the prior state stands.
        const body = (await response.json()) as { requiredCredits: number; balanceCredits: number }
        setStartError({ requiredCredits: body.requiredCredits, balanceCredits: body.balanceCredits })
        setGenerationState(previousState)
        setExpectedRunId(null)
        return
      }
      setStartError(null)
      if (response.status === 202) {
        // Started: the generating state is already showing, and the status checks follow
        // this run to its end - the page re-renders once, then.
        const body = (await response.json()) as { runId?: string; rail?: unknown }
        setExpectedRunId(body.runId ?? null)
        // The rail's figures with the hold in them.
        const rail = parseRailFigures(body.rail)
        if (rail) setFigures(rail)
        return
      }
      // Refused (409, 422, 500): the DB row is the source of truth - resync from the server
      // rather than hand-deriving the new status here.
      setExpectedRunId(null)
      router.refresh()
    } catch {
      // A genuine network failure (e.g. offline) never reached the server, so there is
      // nothing to resync - fall back to a local failed status.
      startingRef.current = false
      setExpectedRunId(null)
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
  // router.refresh(), e.g. a refused start or an agent turn) - this is how a passive tab
  // that never fired its own POST picks up another tab/device's result. Only a real change
  // syncs: on mount the values are the ones state started from, and applying them again
  // would take back the 'generating' the first-load trigger just set (the project has no
  // claim yet), leaving the page on "Planning" with no status checks.
  const syncedRef = useRef({ initialTitle, initialShots, initialVideoType, initialGenerationState, initialHasPendingPayload, initialRun, remainingCredits })
  useEffect(() => {
    const prev = syncedRef.current
    if (
      prev.initialTitle === initialTitle &&
      prev.initialShots === initialShots &&
      prev.initialVideoType === initialVideoType &&
      prev.initialGenerationState === initialGenerationState &&
      prev.initialHasPendingPayload === initialHasPendingPayload &&
      prev.initialRun === initialRun &&
      prev.remainingCredits === remainingCredits
    ) {
      return
    }
    syncedRef.current = { initialTitle, initialShots, initialVideoType, initialGenerationState, initialHasPendingPayload, initialRun, remainingCredits }
    setTitle(initialTitle)
    setShots(initialShots)
    setVideoType(initialVideoType)
    setGenerationState((current) =>
      startingRef.current && current === 'generating' && initialGenerationState !== 'generating' ? current : initialGenerationState
    )
    setHasPendingPayload(initialHasPendingPayload)
    setEndedRun(initialRun)
    setRemaining(remainingCredits)
    // A real refresh cycle has now landed - safe for any field waiting on
    // touchedShotKeys to apply the (now current) value it's holding. See
    // refreshPending's own comment above.
    setRefreshPending(false)
  }, [initialTitle, initialShots, initialVideoType, initialGenerationState, initialHasPendingPayload, initialRun, remainingCredits])

  // A run this tab follows has ended: everything it changed is read fresh in one request -
  // the shot list, its end state, the title, the Assets elements, the run's chat messages and
  // the rail's figures - never a page render. A failed read falls back to a page render.
  async function refreshShotList(): Promise<ShotRunView | null> {
    try {
      const response = await fetch(`/api/projects/${projectId}/shots/list`, { cache: 'no-store' })
      if (!response.ok) throw new Error(`status ${response.status}`)
      const list = (await response.json()) as {
        title: string | null
        shots: DisplayShot[]
        videoType: string | null
        generationState: string | null
        hasPendingPayload: boolean
        run: ShotRunView
        remainingCredits: number
        elements: RunElements | null
        runMessages: AgentMessage[]
        rail: unknown
      }
      // A run only ever sets a title, never clears one.
      setTitle((current) => list.title ?? current)
      setShots(list.shots)
      setVideoType(list.videoType)
      setGenerationState(list.generationState)
      setHasPendingPayload(list.hasPendingPayload)
      setEndedRun(list.run)
      setRemaining(list.remainingCredits)
      if (list.elements) setRunElements(list.elements)
      if (list.runMessages?.length) setRunMessages(list.runMessages)
      const rail = parseRailFigures(list.rail)
      if (rail) setFigures(rail)
      return list.run
    } catch {
      router.refresh()
      return null
    }
  }

  return (
    <ShotsContext.Provider
      value={{
        projectId,
        title,
        shots,
        phase,
        videoType,
        videoModel,
        hasPendingPayload,
        shotListCredits,
        remainingCredits: remaining,
        chargeLine: shotRunChargeLine(endedRun),
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
        runElements,
        runMessages,
      }}
    >
      <ShotRunProvider
        projectId={projectId}
        generating={phase === 'generating'}
        initialRun={initialRun}
        expectedRunId={expectedRunId}
        onRunEnded={refreshShotList}
        onTitle={setTitle}
      >
        {children}
      </ShotRunProvider>
    </ShotsContext.Provider>
  )
}

// ---- The shot run's status -------------------------------------------------------------
// Kept out of ShotsContext on purpose: a status check every few seconds updates only this
// provider's state, so only its consumers (the progress line, the run's banners) re-render -
// never the shot list, the header or anything else reading ShotsContext. Its `children`
// were created by ShotsProvider's parent, so this provider's own updates skip them.

const ShotRunContext = createContext<ShotRunView | null>(null)

function ShotRunProvider({
  projectId,
  generating,
  initialRun,
  expectedRunId,
  onRunEnded,
  onTitle,
  children,
}: {
  projectId: string
  generating: boolean
  initialRun: ShotRunView
  /** Reads the finished shot list and the run's end state (null when the read failed). */
  onRunEnded: () => Promise<ShotRunView | null>
  /** The title a check read - the outline sets it early in a run. A same title re-renders
   * nothing (a state setter that bails out on an equal value). */
  onTitle: (title: string) => void
  /** The run this tab started ('pending' while its start is in flight), or null for a tab
   * that started nothing - it follows whatever run is latest. */
  expectedRunId: string | 'pending' | null
  children: ReactNode
}) {
  const [run, setRun] = useState(initialRun)
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setRun(initialRun)
  }, [initialRun])

  // Checks while generating - a tab that never fired its own start (loaded mid-generation,
  // or on another device) follows the run too. Each check is a lightweight status read
  // (never router.refresh()); the next starts only after the previous returns. Checking
  // stops only when the read belongs to the run this tab started (or, for a tab that
  // started none, the latest run) and that run has ended with its claim settled - a
  // previous run's end never stops it. Then the finished shot list is read once (never a
  // page render, so no other panel re-renders).
  // Paused while the tab is hidden; checks at once on return. The resumed flag is set only
  // while generating and cleared with the loop, so a return before a run never makes that
  // run's first check skip its wait.
  const generatingRef = useRef(generating)
  // Recreated each render; the loop calls the latest.
  const onRunEndedRef = useRef(onRunEnded)
  const onTitleRef = useRef(onTitle)
  useEffect(() => {
    generatingRef.current = generating
    onRunEndedRef.current = onRunEnded
    onTitleRef.current = onTitle
  })
  const resumedRef = useRef(false)
  const visible = usePageVisible(() => {
    if (generatingRef.current) resumedRef.current = true
  })
  useEffect(() => {
    if (!generating || !visible) return
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const poll = async () => {
      try {
        const response = await fetch(`/api/projects/${projectId}/shots/status`, { cache: 'no-store' })
        if (cancelled) return
        if (response.ok) {
          const status = (await response.json()) as { title?: string | null; generationState: string | null; run: ShotRunView }
          if (cancelled) return
          if (typeof status.title === 'string' && status.title !== '') onTitleRef.current(status.title)
          const ours = expectedRunId === null || (expectedRunId !== 'pending' && status.run.id === expectedRunId)
          if (ours) setRun((prev) => (sameShotRunView(prev, status.run) ? prev : status.run))
          const ended = status.run.status !== null && status.run.status !== 'running'
          const settled = status.generationState === 'succeeded' || status.generationState === 'failed'
          if (ours && ended && settled) {
            // The read ends the generating state, so this loop is torn down before it
            // returns - the run's end state is applied regardless.
            const finished = await onRunEndedRef.current()
            if (finished) setRun((prev) => (sameShotRunView(prev, finished) ? prev : finished))
            return
          }
        }
      } catch {
        // A dropped check is retried on the next tick.
      }
      if (!cancelled) timer = setTimeout(poll, SHOT_STATUS_POLL_MS)
    }
    timer = setTimeout(poll, resumedRef.current ? 0 : SHOT_STATUS_POLL_MS)
    resumedRef.current = false
    return () => {
      cancelled = true
      resumedRef.current = false
      clearTimeout(timer)
    }
  }, [generating, visible, projectId, expectedRunId])

  return <ShotRunContext.Provider value={run}>{children}</ShotRunContext.Provider>
}

/** The latest shot run: progress while writing, why it stopped, what is left, its charge. */
export function useShotRun(): ShotRunView {
  const ctx = useContext(ShotRunContext)
  if (!ctx) throw new Error('useShotRun must be used within a ShotsProvider')
  return ctx
}

export function useShots() {
  const ctx = useContext(ShotsContext)
  if (!ctx) throw new Error('useShots must be used within a ShotsProvider')
  return ctx
}
