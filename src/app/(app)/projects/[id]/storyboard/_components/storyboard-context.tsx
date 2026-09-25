'use client'

import { createContext, useCallback, useContext, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { SideColumnOverrideContext } from '@/components/side-column-switch'
import { overwritePromptContent, PromptConfirmModal } from '@/components/prompt-confirm-modal'
import { parseRailFigures, useRailFigures } from '@/components/rail-figures-context'
import { creditsFor } from '@/lib/config/credits'
import type { AspectRatio } from '@/lib/config/enums'
import { filmDuration, laneShots as orderLane, reorderWrites } from '@/lib/storyboard/timeline'
import {
  fitToVoiceover as fitLengths,
  fitUnavailableReason,
  restoreSpanOrderWrites,
  voiceoverOrderDiffers,
  voiceoverStaleness,
  type VoiceoverStaleness,
} from '@/lib/storyboard/voiceover'
import {
  fitToVoiceover as fitToVoiceoverAction,
  restoreScriptOrder as restoreScriptOrderAction,
  saveFilmDuration,
  saveFilmOrder,
  setShotBinned,
} from '../actions'
import { useImageStatusPoll } from './use-image-status-poll'
import type { ImageStatusData, ShotImageStatus, StoryboardShot, VoiceoverStatus } from './types'

export type ActionSource = 'lane' | 'inspect'

export type ActionError =
  | { source: ActionSource; kind: 'credits'; title: string; requiredCredits: number; balanceCredits: number | null }
  | { source: ActionSource; kind: 'error'; message: string }

// Prices are read from credits.ts at the point of display, never copied from the canvas.
export function imagePrice(quantity: number): number {
  return creditsFor({ step: 'storyboard', operation: 'generate_image', quantity })
}

export function promptPrice(): number {
  return creditsFor({ step: 'image_prompts', operation: 'write_image_prompts', quantity: 1 })
}

type StoryboardContextValue = {
  projectId: string
  aspectRatio: AspectRatio
  readOnly: boolean
  shots: StoryboardShot[]
  statusFor: (shotId: string) => ShotImageStatus
  balanceCredits: number | null
  polling: boolean
  selectedShotId: string | null
  select: (shotId: string | null) => void
  busyShotIds: ReadonlySet<string>
  promptBusy: boolean
  actionError: ActionError | null
  generate: (shotIds: string[], source: ActionSource) => Promise<void>
  regeneratePrompt: (shotId: string) => void
  onPromptSaved: (shotId: string, patch: Partial<StoryboardShot>) => void
  // Timeline editing (B2). laneShots is picture order with the bin excluded - what the
  // lane, the counters, the total and Continue all read. binnedShots is the bin, oldest first.
  laneShots: StoryboardShot[]
  binnedShots: StoryboardShot[]
  retimeMaxSec: number | null
  zoomIndex: number
  setZoomIndex: (index: number) => void
  retime: (shotId: string, seconds: number) => void
  reorder: (shotId: string, toLaneIndex: number) => void
  setBinned: (shotId: string, binned: boolean) => void
  restoreScriptOrder: () => void
  // Voiceover (C1). The lane's state rides on the images status poll; refreshStatus re-reads
  // it at once. Staleness and order are computed from the read's spans against the shots.
  voiceover: VoiceoverStatus
  refreshStatus: () => Promise<void>
  voiceoverStaleness: VoiceoverStaleness | null
  voiceoverOrderDiffers: boolean
  fitReason: string | null
  fitToVoiceover: () => void
  /** Shot numbers the last Fit held to the allowed range; null when nothing was clamped. */
  fitClamped: number[] | null
}

const StoryboardContext = createContext<StoryboardContextValue | null>(null)

export function useStoryboard(): StoryboardContextValue {
  const ctx = useContext(StoryboardContext)
  if (!ctx) throw new Error('useStoryboard must be used inside StoryboardProvider')
  return ctx
}

function emptyStatus(shotId: string): ShotImageStatus {
  return {
    shotId,
    state: 'not_generated',
    imagePath: null,
    imageUrl: null,
    thumbUrl: null,
    startedAt: null,
    queuedAt: null,
    drawnAt: null,
  }
}

async function readJson(res: Response): Promise<Record<string, unknown> | null> {
  return (await res.json().catch(() => null)) as Record<string, unknown> | null
}

// Owns the page's client state. Every server round trip is a plain fetch that updates this
// state; the page never re-renders from the server after load.
export function StoryboardProvider({
  projectId,
  aspectRatio,
  readOnly,
  retimeMaxSec,
  initialShots,
  initialStatus,
  children,
}: {
  projectId: string
  aspectRatio: AspectRatio
  readOnly: boolean
  retimeMaxSec: number | null
  initialShots: StoryboardShot[]
  initialStatus: ImageStatusData
  children: ReactNode
}) {
  const [shots, setShots] = useState(initialShots)
  const { data, polling, refresh } = useImageStatusPoll(projectId, initialStatus)
  const [selectedShotId, setSelectedShotId] = useState<string | null>(null)
  const [busyShotIds, setBusyShotIds] = useState<ReadonlySet<string>>(new Set())
  const [promptBusy, setPromptBusy] = useState(false)
  const [actionError, setActionError] = useState<ActionError | null>(null)
  const [overwriteShotId, setOverwriteShotId] = useState<string | null>(null)
  const { setFigures } = useRailFigures()
  const [zoomIndex, setZoomIndex] = useState(0)

  // The latest shots, for the timeline mutators: they read current values without being
  // rebuilt (and re-rendering every memo'd block) on each change.
  const shotsRef = useRef(shots)
  useLayoutEffect(() => {
    shotsRef.current = shots
  }, [shots])

  const patchShots = useCallback((patches: Map<string, Partial<StoryboardShot>>) => {
    setShots((prev) => prev.map((shot) => (patches.has(shot.id) ? { ...shot, ...patches.get(shot.id) } : shot)))
  }, [])

  // Optimistic: the edit applies at once, the save runs behind it, and nothing is re-read
  // afterwards. A failed save rolls back only the fields that still hold this edit's value -
  // a later edit to the same shot has already superseded it (last write wins).
  const commitEdit = useCallback(
    async <K extends keyof StoryboardShot>(
      field: K,
      next: Map<string, StoryboardShot[K]>,
      save: () => Promise<{ success: boolean }>
    ) => {
      const before = new Map(shotsRef.current.filter((s) => next.has(s.id)).map((s) => [s.id, s[field]]))
      patchShots(new Map([...next].map(([id, value]) => [id, { [field]: value } as Partial<StoryboardShot>])))
      setActionError((prev) => (prev?.source === 'lane' && prev.kind === 'error' ? null : prev))
      const ok = await save().then(
        (r) => r.success,
        () => false
      )
      if (ok) return
      setShots((prev) =>
        prev.map((shot) =>
          next.has(shot.id) && before.has(shot.id) && shot[field] === next.get(shot.id)
            ? { ...shot, [field]: before.get(shot.id) }
            : shot
        )
      )
      setActionError({ source: 'lane', kind: 'error', message: "That change couldn't be saved, so it was undone. Try again." })
    },
    [patchShots]
  )

  const retime = useCallback(
    (shotId: string, seconds: number) => {
      const shot = shotsRef.current.find((s) => s.id === shotId)
      if (readOnly || !shot || filmDuration(shot) === seconds) return
      void commitEdit('film_duration_sec', new Map([[shotId, seconds]]), () =>
        saveFilmDuration(projectId, shotId, seconds)
      )
    },
    [projectId, readOnly, commitEdit]
  )

  const reorder = useCallback(
    (shotId: string, toLaneIndex: number) => {
      if (readOnly) return
      const writes = reorderWrites(shotsRef.current, shotId, toLaneIndex)
      if (writes.length === 0) return
      void commitEdit('film_order', new Map(writes.map((w) => [w.id, w.film_order])), () =>
        saveFilmOrder(projectId, writes)
      )
    },
    [projectId, readOnly, commitEdit]
  )

  const setBinned = useCallback(
    (shotId: string, binned: boolean) => {
      const shot = shotsRef.current.find((s) => s.id === shotId)
      if (readOnly || !shot || (shot.binned_at !== null) === binned) return
      if (binned) setSelectedShotId((prev) => (prev === shotId ? null : prev))
      void commitEdit('binned_at', new Map([[shotId, binned ? new Date().toISOString() : null]]), () =>
        setShotBinned(projectId, shotId, binned)
      )
    },
    [projectId, readOnly, commitEdit]
  )

  const voiceover = data.voiceover
  const spans = voiceover.current?.spans ?? null

  // With a voiceover, script order is the order it was read in (the server recomputes the
  // same writes); without one, the Storyboard's own order is cleared.
  const restoreScriptOrder = useCallback(() => {
    if (readOnly) return
    if (spans) {
      const writes = restoreSpanOrderWrites(spans, shotsRef.current)
      if (writes.length === 0) return
      void commitEdit('film_order', new Map(writes.map((w) => [w.id, w.film_order])), () =>
        restoreScriptOrderAction(projectId)
      )
      return
    }
    const reset = new Map(shotsRef.current.filter((s) => s.film_order !== null).map((s) => [s.id, null]))
    if (reset.size === 0) return
    void commitEdit('film_order', reset, () => restoreScriptOrderAction(projectId))
  }, [projectId, readOnly, commitEdit, spans])

  const staleness = useMemo(() => (spans ? voiceoverStaleness(spans, shots) : null), [spans, shots])
  const orderDiffers = useMemo(() => (spans ? voiceoverOrderDiffers(spans, shots) : false), [spans, shots])
  const fitReason = fitUnavailableReason({
    hasVoiceover: voiceover.current !== null,
    inFlight: voiceover.state === 'generating',
    stale: staleness?.stale ?? false,
    orderDiffers,
    maxSec: retimeMaxSec,
  })
  const [fitClamped, setFitClamped] = useState<number[] | null>(null)

  // Fit to voiceover: applied at once from the same rule the server runs, then saved (the
  // server recomputes from the stored spans, never from these lengths). Free.
  const currentRead = voiceover.current
  const fitToVoiceover = useCallback(() => {
    if (readOnly || fitReason || !currentRead || retimeMaxSec === null) return
    const result = fitLengths(currentRead.spans, shotsRef.current, currentRead.durationSec, retimeMaxSec)
    const byId = new Map(shotsRef.current.map((s) => [s.id, s]))
    setFitClamped(result.clamped.length > 0 ? result.clamped.map((id) => (byId.get(id)?.order_index ?? 0) + 1) : null)
    if (result.writes.length === 0) return
    void commitEdit('film_duration_sec', new Map(result.writes.map((w) => [w.id, w.film_duration_sec])), () =>
      fitToVoiceoverAction(projectId)
    )
  }, [projectId, readOnly, fitReason, currentRead, retimeMaxSec, commitEdit])

  const laneShots = useMemo(() => orderLane(shots), [shots])
  const binnedShots = useMemo(
    () => shots.filter((s) => s.binned_at !== null).sort((a, b) => a.binned_at!.localeCompare(b.binned_at!)),
    [shots]
  )

  const statusById = useMemo(() => new Map(data.shots.map((s) => [s.shotId, s])), [data.shots])
  const statusFor = useCallback((shotId: string) => statusById.get(shotId) ?? emptyStatus(shotId), [statusById])

  const select = useCallback((shotId: string | null) => {
    setSelectedShotId(shotId)
    setActionError((prev) => (prev?.source === 'inspect' ? null : prev))
  }, [])

  const generate = useCallback(
    async (shotIds: string[], source: ActionSource) => {
      if (readOnly || shotIds.length === 0) return
      setActionError(null)
      setBusyShotIds((prev) => new Set([...prev, ...shotIds]))
      try {
        const res = await fetch(`/api/projects/${projectId}/images`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ shotIds }),
        })
        const body = await readJson(res)
        const rail = parseRailFigures(body?.rail)
        if (rail) setFigures(rail)
        if (res.status === 402) {
          setActionError({
            source,
            kind: 'credits',
            title: shotIds.length === 1 ? 'Not enough credits to draw this frame' : 'Not enough credits to draw these frames',
            requiredCredits: Number(body?.requiredCredits ?? imagePrice(shotIds.length)),
            balanceCredits: typeof body?.balanceCredits === 'number' ? body.balanceCredits : null,
          })
        } else if (!res.ok) {
          setActionError({ source, kind: 'error', message: "The frame couldn't be started. Try again." })
        }
      } catch {
        setActionError({ source, kind: 'error', message: "The frame couldn't be started. Try again." })
      } finally {
        setBusyShotIds((prev) => {
          const next = new Set(prev)
          shotIds.forEach((id) => next.delete(id))
          return next
        })
        // Restart the poll: the claims just written read as queued straight away.
        await refresh()
      }
    },
    [projectId, readOnly, refresh, setFigures]
  )

  const runPromptRegeneration = useCallback(
    async (shotId: string) => {
      setActionError(null)
      setPromptBusy(true)
      try {
        const res = await fetch(`/api/projects/${projectId}/image-prompts`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ shotIds: [shotId], retry: true }),
        })
        const body = await readJson(res)
        const rail = parseRailFigures(body?.rail)
        if (rail) setFigures(rail)
        if (res.ok && Array.isArray(body?.shots)) {
          const byId = new Map((body.shots as StoryboardShot[]).map((s) => [s.id, s]))
          setShots((prev) =>
            prev.map((shot) => {
              const next = byId.get(shot.id)
              return next
                ? {
                    ...shot,
                    image_prompt: next.image_prompt,
                    image_prompt_edited: next.image_prompt_edited,
                    image_prompt_stale: next.image_prompt_stale,
                    image_stale: next.image_stale,
                  }
                : shot
            })
          )
        } else if (res.status === 402) {
          setActionError({
            source: 'inspect',
            kind: 'credits',
            title: 'Not enough credits to write this prompt',
            requiredCredits: Number(body?.requiredCredits ?? promptPrice()),
            balanceCredits: typeof body?.balanceCredits === 'number' ? body.balanceCredits : null,
          })
        } else if (res.status === 409) {
          setActionError({ source: 'inspect', kind: 'error', message: 'A prompt is already being written. Try again in a moment.' })
        } else {
          setActionError({ source: 'inspect', kind: 'error', message: "The prompt couldn't be rewritten. Try again." })
        }
      } catch {
        setActionError({ source: 'inspect', kind: 'error', message: "The prompt couldn't be rewritten. Try again." })
      } finally {
        setPromptBusy(false)
        // A changed prompt marks the image stale server-side; the status read shows it.
        await refresh()
      }
    },
    [projectId, refresh, setFigures]
  )

  const regeneratePrompt = useCallback(
    (shotId: string) => {
      if (readOnly) return
      const shot = shots.find((s) => s.id === shotId)
      if (!shot) return
      // The overwrite confirmation guards handwriting only - an unedited prompt regenerates
      // straight away, exactly as on Step 3.
      if (shot.image_prompt_edited) setOverwriteShotId(shotId)
      else void runPromptRegeneration(shotId)
    },
    [readOnly, shots, runPromptRegeneration]
  )

  // A real hand edit of the prompt. The server marked the image stale in the same write;
  // image state is only ever read from the status endpoint, so re-read it there.
  const onPromptSaved = useCallback(
    (shotId: string, patch: Partial<StoryboardShot>) => {
      setShots((prev) => prev.map((shot) => (shot.id === shotId ? { ...shot, ...patch } : shot)))
      void refresh()
    },
    [refresh]
  )

  const overwriteShot = overwriteShotId ? shots.find((s) => s.id === overwriteShotId) : undefined
  const cancelOverwrite = useCallback(() => setOverwriteShotId(null), [])
  const confirmOverwrite = useCallback(() => {
    const id = overwriteShotId
    setOverwriteShotId(null)
    if (id) void runPromptRegeneration(id)
  }, [overwriteShotId, runPromptRegeneration])

  const value = useMemo<StoryboardContextValue>(
    () => ({
      projectId,
      aspectRatio,
      readOnly,
      shots,
      statusFor,
      balanceCredits: data.balanceCredits,
      polling,
      selectedShotId,
      select,
      busyShotIds,
      promptBusy,
      actionError,
      generate,
      regeneratePrompt,
      onPromptSaved,
      laneShots,
      binnedShots,
      retimeMaxSec,
      zoomIndex,
      setZoomIndex,
      retime,
      reorder,
      setBinned,
      restoreScriptOrder,
      voiceover,
      refreshStatus: refresh,
      voiceoverStaleness: staleness,
      voiceoverOrderDiffers: orderDiffers,
      fitReason,
      fitToVoiceover,
      fitClamped,
    }),
    [
      projectId,
      aspectRatio,
      readOnly,
      shots,
      statusFor,
      data.balanceCredits,
      polling,
      selectedShotId,
      select,
      busyShotIds,
      promptBusy,
      actionError,
      generate,
      regeneratePrompt,
      onPromptSaved,
      laneShots,
      binnedShots,
      retimeMaxSec,
      zoomIndex,
      retime,
      reorder,
      setBinned,
      restoreScriptOrder,
      voiceover,
      refresh,
      staleness,
      orderDiffers,
      fitReason,
      fitToVoiceover,
      fitClamped,
    ]
  )

  return (
    <StoryboardContext.Provider value={value}>
      <SideColumnOverrideContext.Provider value={selectedShotId !== null}>{children}</SideColumnOverrideContext.Provider>
      <PromptConfirmModal
        content={overwriteShot ? overwritePromptContent(overwriteShot.order_index + 1, overwriteShot.image_prompt ?? '') : null}
        credits={promptPrice()}
        onConfirm={confirmOverwrite}
        onCancel={cancelOverwrite}
      />
    </StoryboardContext.Provider>
  )
}
