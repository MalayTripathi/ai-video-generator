'use client'

import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useRouter } from 'next/navigation'
import { creditsFor } from '@/lib/config/credits'
import type { AspectRatio } from '@/lib/config/enums'
import type { PromptShot } from './types'
import { isEdited, isStale, isUngenerated } from './derive-image-prompts-phase'
import { AgentLocksContext } from '@/components/workbench/agent-locks-context'
import { checkImagePromptsAffordability } from '../actions'

export type Outcome =
  | {
      kind: 'partial'
      scopeSize: number
      updatedIds: string[]
      // Failed shots that still hold an earlier prompt / that never had one.
      keptIds: string[]
      unwrittenIds: string[]
      code: string
      at: string
    }
  | { kind: 'failed'; code: string; at: string; retryIds: string[] }
  | { kind: 'insufficient'; required: number; balance: number | null }

export type PromptModal = { kind: 'overwrite'; shotId: string } | { kind: 'all' } | null

type ImagePromptsContextValue = {
  projectId: string
  aspectRatio: AspectRatio
  readOnly: boolean
  shots: PromptShot[]
  // One request at a time: the generation claim is project-level, so a second concurrent
  // call would only be refused. Editing stays available throughout.
  requestInFlight: boolean
  // Regenerate controls are unavailable: read-only, our own request running, or another
  // window's generation running.
  regenerateLocked: boolean
  // The balance preflight is running (nothing is being written yet).
  checking: boolean
  busyIds: Set<string>
  // A generation started elsewhere (another tab) is running; we poll until it settles.
  externalGenerating: boolean
  outcome: Outcome | null
  modal: PromptModal
  staleCount: number
  costFor: (shotCount: number) => number
  updateShotLocal: (shotId: string, patch: Partial<PromptShot>) => void
  regenerateOne: (shotId: string) => void
  regenerateAll: () => void
  regenerateStale: () => void
  retryOutcome: () => void
  confirmModal: () => void
  cancelModal: () => void
  dismissOutcome: () => void
}

const ImagePromptsContext = createContext<ImagePromptsContextValue | null>(null)

export function useImagePrompts() {
  const ctx = useContext(ImagePromptsContext)
  if (!ctx) throw new Error('useImagePrompts must be used within ImagePromptsProvider')
  return ctx
}

type ReturnedRow = {
  id: string
  image_prompt: string | null
  image_prompt_stale: boolean
  image_prompt_edited: boolean
}

const POLL_INTERVAL_MS = 4000
const POLL_MAX_ATTEMPTS = 90

function costFor(shotCount: number): number {
  return creditsFor({ step: 'image_prompts', operation: 'write_image_prompts', quantity: shotCount })
}

function clockTime(): string {
  return new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })
}

export function ImagePromptsProvider({
  projectId,
  initialShots,
  initialGenerationState,
  autoGenerate,
  initialInsufficient,
  aspectRatio,
  readOnly,
  children,
}: {
  projectId: string
  initialShots: PromptShot[]
  initialGenerationState: string | null
  // Decided by the page, which has already confirmed the balance covers it - so the
  // skeleton shown on arrival is never for a request that will be refused.
  autoGenerate: boolean
  // The first run was not started because the balance is short.
  initialInsufficient: { required: number; balance: number } | null
  aspectRatio: AspectRatio
  readOnly: boolean
  children: ReactNode
}) {
  const router = useRouter()

  const [shots, setShots] = useState(initialShots)
  // Cards our own button-driven request is writing. Kept apart from the agent's locks below:
  // a request settling clears only its own ids, never a lock the agent still holds.
  const [runBusyIds, setBusyIds] = useState<Set<string>>(
    () => new Set(autoGenerate ? initialShots.map((s) => s.id) : [])
  )
  // Cards the agent's current tool is writing (see AgentLocksContext). A locked card is a
  // busy card: its editor gives way to the writing state, exactly as for a Regenerate, so a
  // hand edit cannot race the agent's write and be silently overwritten.
  const [agentLockedIds, setAgentLockedIds] = useState<Set<string>>(() => new Set())
  const busyIds = useMemo(() => new Set([...runBusyIds, ...agentLockedIds]), [runBusyIds, agentLockedIds])
  const [outcome, setOutcome] = useState<Outcome | null>(
    initialInsufficient
      ? { kind: 'insufficient', required: initialInsufficient.required, balance: initialInsufficient.balance }
      : null
  )
  // The balance preflight is in flight: nothing is being written yet, so no card shows
  // its writing state, but a second request must not start.
  const [checking, setChecking] = useState(false)
  const [modal, setModal] = useState<PromptModal>(null)
  const [externalFlag, setExternalFlag] = useState(false)
  const [gaveUp, setGaveUp] = useState(false)
  const externalGenerating = !gaveUp && (externalFlag || initialGenerationState === 'generating')

  const shotsRef = useRef(shots)
  useEffect(() => {
    shotsRef.current = shots
  })
  const inflightRef = useRef(false)
  const autoFiredRef = useRef(false)

  // Server truth wins whenever nothing of ours is in flight - this is what lets an
  // agent edit (which refreshes the page) or a settled external generation land. A prompt
  // field mid-edit keeps its own local draft (see prompt-editor.tsx), so this never
  // clobbers typing. Adjusted during render, keyed on the incoming props, rather than in
  // an effect.
  const [seenShots, setSeenShots] = useState(initialShots)
  if (seenShots !== initialShots) {
    setSeenShots(initialShots)
    if (busyIds.size === 0) setShots(initialShots)
  }
  const [seenGenerationState, setSeenGenerationState] = useState(initialGenerationState)
  if (seenGenerationState !== initialGenerationState) {
    setSeenGenerationState(initialGenerationState)
    setExternalFlag(false)
    setGaveUp(false)
  }

  useEffect(() => {
    if (!externalGenerating) return
    let attempts = 0
    const timer = setInterval(() => {
      attempts += 1
      if (attempts > POLL_MAX_ATTEMPTS) {
        clearInterval(timer)
        setGaveUp(true)
        setOutcome({
          kind: 'failed',
          code: 'timeout',
          at: clockTime(),
          retryIds: shotsRef.current.filter(isUngenerated).map((s) => s.id),
        })
        return
      }
      router.refresh()
    }, POLL_INTERVAL_MS)
    return () => clearInterval(timer)
  }, [externalGenerating, router])

  const agentLocks = useMemo(
    () => ({
      lockShot: (shotKey: string) => {
        const shot = shotsRef.current.find((s) => s.shot_key === shotKey)
        if (shot) setAgentLockedIds((prev) => new Set(prev).add(shot.id))
      },
      unlockAllShots: () => setAgentLockedIds(new Set()),
    }),
    []
  )

  function updateShotLocal(shotId: string, patch: Partial<PromptShot>) {
    setShots((prev) => prev.map((s) => (s.id === shotId ? { ...s, ...patch } : s)))
  }

  function mergeRows(rows: ReturnedRow[]) {
    const byId = new Map(rows.map((r) => [r.id, r]))
    setShots((prev) =>
      prev.map((s) => {
        const row = byId.get(s.id)
        if (!row) return s
        return {
          ...s,
          image_prompt: row.image_prompt,
          image_prompt_stale: row.image_prompt_stale,
          image_prompt_edited: row.image_prompt_edited,
        }
      })
    )
  }

  async function run(ids: string[], retry: boolean, opts?: { skipPreflight?: boolean }) {
    if (inflightRef.current || ids.length === 0) return
    inflightRef.current = true
    setOutcome(null)
    setModal(null)

    // Ask about the balance BEFORE entering the writing state: a request that will be
    // refused must never show "Writing…". The route re-checks authoritatively (and before
    // its claim), so an inconclusive or racing answer here is harmless.
    if (!opts?.skipPreflight) {
      setChecking(true)
      let affordability: Awaited<ReturnType<typeof checkImagePromptsAffordability>> | null = null
      try {
        affordability = await checkImagePromptsAffordability(projectId, ids)
      } catch {
        affordability = null
      }
      setChecking(false)
      if (affordability && !affordability.ok && affordability.reason === 'insufficient') {
        setOutcome({
          kind: 'insufficient',
          required: affordability.requiredCredits,
          balance: affordability.balanceCredits,
        })
        inflightRef.current = false
        return
      }
    }

    setBusyIds(new Set(ids))

    const before = shotsRef.current
    const keyById = new Map(before.map((s) => [s.id, s.shot_key]))
    const hadPrompt = new Set(before.filter((s) => !isUngenerated(s)).map((s) => s.id))
    // Set true for a response that is known to have spent nothing (or that already
    // refreshes for its own reasons); everything else may have charged, so the rail's
    // usage figure is refreshed once the request settles.
    let spendUnlikely = false

    try {
      const res = await fetch(`/api/projects/${projectId}/image-prompts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ shotIds: ids, retry }),
      })
      const body = await res.json().catch(() => null)

      if (res.ok && Array.isArray(body?.shots)) {
        mergeRows(body.shots as ReturnedRow[])
        return
      }

      if (res.status === 422 && Array.isArray(body?.shots)) {
        mergeRows(body.shots as ReturnedRow[])
        const failedKeys = new Set<string>([...(body.missingShotKeys ?? []), ...(body.failedShotKeys ?? [])])
        const failedIds = ids.filter((id) => failedKeys.has(keyById.get(id) ?? ''))
        if (failedIds.length > 0) {
          setOutcome({
            kind: 'partial',
            scopeSize: ids.length,
            updatedIds: ids.filter((id) => !failedIds.includes(id)),
            keptIds: failedIds.filter((id) => hadPrompt.has(id)),
            unwrittenIds: failedIds.filter((id) => !hadPrompt.has(id)),
            code: String(res.status),
            at: clockTime(),
          })
          return
        }
      }

      // Refused before any spend (the balance gate runs before the claim).
      if (res.status === 402) {
        spendUnlikely = true
        setOutcome({
          kind: 'insufficient',
          required: typeof body?.requiredCredits === 'number' ? body.requiredCredits : costFor(ids.length),
          balance: typeof body?.balanceCredits === 'number' ? body.balanceCredits : null,
        })
        return
      }

      // Another window already holds the claim: wait for it to settle rather than fail.
      if (res.status === 409 && body?.reason === 'already_generating') {
        spendUnlikely = true
        setExternalFlag(true)
        router.refresh()
        return
      }

      setOutcome({ kind: 'failed', code: String(res.status), at: clockTime(), retryIds: ids })
      // A 409 for any other reason means our view is out of date.
      if (res.status === 409) {
        spendUnlikely = true
        router.refresh()
      }
    } catch {
      setOutcome({ kind: 'failed', code: 'network', at: clockTime(), retryIds: ids })
    } finally {
      inflightRef.current = false
      setBusyIds(new Set())
      // The rail's usage figure comes from the (app) layout, which holds no client state;
      // a fresh server render is the codebase's own way to update it (element reference
      // generation and agent turns do the same). Once per settled request, never polled.
      if (!spendUnlikely) router.refresh()
    }
  }

  // The one automatic generation, ref-guarded so a re-render or a StrictMode remount can
  // never fire it twice. retry:false - nothing has ever been attempted, so a 409 here
  // means someone else got there first and must not be overridden.
  useEffect(() => {
    if (!autoGenerate || autoFiredRef.current) return
    autoFiredRef.current = true
    void run(
      initialShots.map((s) => s.id),
      false,
      { skipPreflight: true }
    )
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const staleIds = shots.filter(isStale).map((s) => s.id)

  function regenerateOne(shotId: string) {
    const shot = shotsRef.current.find((s) => s.id === shotId)
    if (!shot || readOnly || inflightRef.current || externalGenerating) return
    // Only a hand-written prompt is worth a dialog: it protects handwriting, it does not
    // gate spending.
    if (isEdited(shot)) {
      setModal({ kind: 'overwrite', shotId })
      return
    }
    void run([shotId], true)
  }

  function regenerateAll() {
    if (readOnly || inflightRef.current || externalGenerating) return
    setModal({ kind: 'all' })
  }

  function regenerateStale() {
    if (readOnly || staleIds.length === 0) return
    void run(staleIds, true)
  }

  function retryOutcome() {
    if (!outcome) return
    if (outcome.kind === 'partial') {
      void run([...outcome.keptIds, ...outcome.unwrittenIds], true)
    } else if (outcome.kind === 'failed') {
      void run(outcome.retryIds, true)
    }
  }

  function confirmModal() {
    if (!modal) return
    if (modal.kind === 'overwrite') void run([modal.shotId], true)
    else void run(shotsRef.current.map((s) => s.id), true)
  }

  const value: ImagePromptsContextValue = {
    projectId,
    aspectRatio,
    readOnly,
    shots,
    requestInFlight: busyIds.size > 0,
    checking,
    regenerateLocked: readOnly || checking || busyIds.size > 0 || externalGenerating,
    busyIds,
    externalGenerating,
    outcome,
    modal,
    staleCount: staleIds.length,
    costFor,
    updateShotLocal,
    regenerateOne,
    regenerateAll,
    regenerateStale,
    retryOutcome,
    confirmModal,
    cancelModal: () => setModal(null),
    dismissOutcome: () => setOutcome(null),
  }

  return (
    <ImagePromptsContext.Provider value={value}>
      <AgentLocksContext.Provider value={agentLocks}>{children}</AgentLocksContext.Provider>
    </ImagePromptsContext.Provider>
  )
}
