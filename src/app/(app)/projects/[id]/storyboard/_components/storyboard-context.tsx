'use client'

import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { SideColumnOverrideContext } from '@/components/side-column-switch'
import { overwritePromptContent, PromptConfirmModal } from '@/components/prompt-confirm-modal'
import { parseRailFigures, useRailFigures } from '@/components/rail-figures-context'
import { creditsFor } from '@/lib/config/credits'
import type { AspectRatio, Motion, Transition } from '@/lib/config/enums'
import { clampSplit, resolveJoins, resolveMotions, type ResolvedJoin, type ResolvedMotion } from '@/lib/storyboard/motion'
import {
  filmDuration,
  filmSeconds,
  laneShots as orderLane,
  readiness,
  reorderWrites,
  storyboardRetimeRange,
  type Readiness,
  type RetimeBounds,
} from '@/lib/storyboard/timeline'
import { isRegisteredVideoModel, VIDEO_MODELS } from '@/lib/config/models'
import { MIX_SAVE_DEBOUNCE_MS } from '@/lib/config/storyboard'
import { buildFilmTimeline, placeWords, voicePieces, type FilmTimeline, type MixColumn, type StoredMix } from '@/lib/storyboard/film'
import { toFilmInput } from '@/lib/export/film-input'
import { filmHash as hashFilm } from '@/lib/export/film-hash'
import {
  resolveExportSettings,
  resolveFilmDefaults,
  type ExportSettingColumn,
  type ExportSettings,
  type StoredExportSettings,
} from '@/lib/export/settings'
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
  keepManualTiming as keepManualTimingAction,
  resetMix as resetMixAction,
  saveMix,
  saveExportSetting,
  type MixValue,
  restoreScriptOrder as restoreScriptOrderAction,
  saveFilmDuration,
  saveFilmOrder,
  saveShotMotion,
  saveShotSplit,
  saveTransition,
  setShotBinned,
  type MotionSegment,
} from '../actions'
import { useImageStatusPoll } from './use-image-status-poll'
import type { ImageStatusData, MusicStatus, ShotImageStatus, StoryboardShot, VoiceoverStatus } from './types'

export type ActionSource = 'lane' | 'inspect'

/** The mix as the project stores it (null = default); voiceover mute rides on the voiceover status. */
export type MixState = Omit<StoredMix, 'voiceover_muted'>

// The timeline's two modes (canvas 15b / 15d): one strip, the same geometry.
export type TimelineMode = 'retime' | 'motion'

/** A shot selected in Motion mode, and which of its segments (b only when split). */
export type SegmentSelection = { shotId: string; segment: MotionSegment }

export type ActionError =
  | { source: ActionSource; kind: 'credits'; title: string; requiredCredits: number; balanceCredits: number | null }
  | { source: ActionSource; kind: 'error'; message: string }

// Prices are read from credits.ts at the point of display, never copied from the canvas. A
// frame's price is computed server-side per shot (its project's image quality and size,
// plus its own references) and arrives on its status, so a batch is the sum of its shots.
export function imagePrice(statuses: readonly ShotImageStatus[]): number {
  return statuses.reduce((sum, status) => sum + status.imageCredits, 0)
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
  zoomIndex: number
  setZoomIndex: (index: number) => void
  retime: (shotId: string, seconds: number) => void
  reorder: (shotId: string, toLaneIndex: number) => void
  setBinned: (shotId: string, binned: boolean) => void
  restoreScriptOrder: () => void
  // Voiceover (C1). The lane's state rides on the images status poll; refreshStatus re-reads
  // it at once. Staleness and order are computed from the read's spans against the shots.
  voiceover: VoiceoverStatus
  // Music (D). Rides on the same poll.
  music: MusicStatus
  refreshStatus: () => Promise<void>
  voiceoverStaleness: VoiceoverStaleness | null
  voiceoverOrderDiffers: boolean
  fitReason: string | null
  fitToVoiceover: () => void
  /** The shortest and longest a retime may make a shot - the project's video model's range. */
  retimeRange: RetimeBounds
  /** Shot numbers the last Fit held to the allowed range; null when nothing was clamped. */
  fitClamped: number[] | null
  // Motion & transitions (B3). Resolved from the lane by the shared pure rules; edits are
  // free, optimistic, and mark nothing stale.
  mode: TimelineMode
  setMode: (mode: TimelineMode) => void
  motions: Map<string, ResolvedMotion>
  joins: ResolvedJoin[]
  selectedSegment: SegmentSelection | null
  selectSegment: (selection: SegmentSelection | null) => void
  selectedJoinShotId: string | null
  selectJoin: (shotId: string | null) => void
  setMotion: (shotId: string, segment: MotionSegment, motion: Motion | null) => void
  setSplit: (shotId: string, splitAt: number | null) => void
  setTransition: (shotId: string, transition: Transition | null) => void
  // Preview & mix (E). The film is the one timeline preview plays (and export renders);
  // mix edits are optimistic, debounced, free, and mark nothing stale.
  film: FilmTimeline
  frameReadiness: Readiness
  /** Every in-film frame has an image - Preview, Play and Export unlock on this. */
  framesReady: boolean
  mix: MixState
  mixError: string | null
  setMixField: (field: MixColumn, value: MixValue) => void
  resetMix: () => void
  // Export (F). The settings as stored (null = default) and as they resolve; the motion and
  // transition settings are the film defaults the lane and the film resolve with.
  exportSettings: StoredExportSettings
  resolvedExport: ExportSettings
  setExportSetting: (field: ExportSettingColumn, value: string | null) => void
  exportSettingError: string | null
  /** The live film's fingerprint - an export with a different one reads "Edited since". */
  filmHash: string
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
    // Unpriced until the next poll returns this shot; the server's gate prices it either way.
    imageCredits: 0,
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
  videoModel,
  initialShots,
  initialStatus,
  initialMix,
  initialExportSettings,
  children,
}: {
  projectId: string
  aspectRatio: AspectRatio
  readOnly: boolean
  videoModel: string | null
  initialShots: StoryboardShot[]
  initialStatus: ImageStatusData
  initialMix: MixState
  initialExportSettings: StoredExportSettings
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
  const [mode, setModeState] = useState<TimelineMode>('retime')
  const [selectedSegment, setSelectedSegment] = useState<SegmentSelection | null>(null)
  const [selectedJoinShotId, setSelectedJoinShotId] = useState<string | null>(null)

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
  const commitPatches = useCallback(
    async (patches: Map<string, Partial<StoryboardShot>>, save: () => Promise<{ success: boolean }>) => {
      const before = new Map(
        shotsRef.current
          .filter((s) => patches.has(s.id))
          .map((s) => [
            s.id,
            Object.fromEntries(Object.keys(patches.get(s.id)!).map((k) => [k, s[k as keyof StoryboardShot]])) as Partial<StoryboardShot>,
          ])
      )
      patchShots(patches)
      setActionError((prev) => (prev?.source === 'lane' && prev.kind === 'error' ? null : prev))
      const ok = await save().then(
        (r) => r.success,
        () => false
      )
      if (ok) return
      setShots((prev) =>
        prev.map((shot) => {
          const patch = patches.get(shot.id)
          const was = before.get(shot.id)
          if (!patch || !was) return shot
          const revert = Object.fromEntries(
            Object.entries(patch)
              .filter(([k, v]) => shot[k as keyof StoryboardShot] === v)
              .map(([k]) => [k, was[k as keyof StoryboardShot]])
          )
          return Object.keys(revert).length > 0 ? { ...shot, ...revert } : shot
        })
      )
      setActionError({ source: 'lane', kind: 'error', message: "That change couldn't be saved, so it was undone. Try again." })
    },
    [patchShots]
  )

  const commitEdit = useCallback(
    <K extends keyof StoryboardShot>(
      field: K,
      next: Map<string, StoryboardShot[K]>,
      save: () => Promise<{ success: boolean }>
    ) =>
      commitPatches(new Map([...next].map(([id, value]) => [id, { [field]: value } as Partial<StoryboardShot>])), save),
    [commitPatches]
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
      if (binned) {
        setSelectedShotId((prev) => (prev === shotId ? null : prev))
        setSelectedSegment((prev) => (prev?.shotId === shotId ? null : prev))
      }
      void commitEdit('binned_at', new Map([[shotId, binned ? new Date().toISOString() : null]]), () =>
        setShotBinned(projectId, shotId, binned)
      )
    },
    [projectId, readOnly, commitEdit]
  )

  const voiceover = data.voiceover
  const spans = voiceover.current?.spans ?? null
  const music = data.music

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
  // Fit rounds each length to the project's video model, so it needs a registered one.
  const fitModel = useMemo(() => (isRegisteredVideoModel(videoModel) ? VIDEO_MODELS[videoModel] : null), [videoModel])
  const retimeRange = useMemo(() => storyboardRetimeRange(videoModel), [videoModel])
  const fitReason = fitModel
    ? fitUnavailableReason({
        hasVoiceover: voiceover.current !== null,
        inFlight: voiceover.state === 'generating',
        stale: staleness?.stale ?? false,
        orderDiffers,
      })
    : "Shot lengths can't be fitted for this project's video model."
  const [fitClamped, setFitClamped] = useState<number[] | null>(null)

  // Fit to voiceover: applied at once from the same rule the server runs, then saved (the
  // server recomputes from the stored spans, never from these lengths). Free.
  const currentRead = voiceover.current
  const fitToVoiceover = useCallback(() => {
    if (readOnly || fitReason || !currentRead || !fitModel) return
    const result = fitLengths(currentRead.spans, shotsRef.current, fitModel)
    const byId = new Map(shotsRef.current.map((s) => [s.id, s]))
    setFitClamped(result.clamped.length > 0 ? result.clamped.map((id) => (byId.get(id)?.order_index ?? 0) + 1) : null)
    if (result.writes.length === 0) return
    void commitEdit('film_duration_sec', new Map(result.writes.map((w) => [w.id, w.film_duration_sec])), () =>
      fitToVoiceoverAction(projectId)
    )
  }, [projectId, readOnly, fitReason, currentRead, fitModel, commitEdit])

  // A read that lands while the page is open was fitted by the server as it was saved (the
  // auto-fit), unless it is waiting on "Refit timing?": mirror those lengths locally with
  // the same rule, without saving again.
  const seenReadAt = useRef(currentRead?.generatedAt ?? null)
  useEffect(() => {
    const at = currentRead?.generatedAt ?? null
    if (at === seenReadAt.current) return
    seenReadAt.current = at
    if (!currentRead || !fitModel || currentRead.refitPending || fitReason) return
    const result = fitLengths(currentRead.spans, shotsRef.current, fitModel)
    if (result.writes.length > 0) patchShots(new Map(result.writes.map((w) => [w.id, { film_duration_sec: w.film_duration_sec }])))
  }, [currentRead, fitModel, fitReason, patchShots])

  // "Refit timing?": a new read replaced one the shots were fitted to, after a hand retime.
  const [refitAnswered, setRefitAnswered] = useState<string | null>(null)
  const refitAsk = !readOnly && !!currentRead?.refitPending && refitAnswered !== currentRead.generatedAt && !fitReason
  const answerRefit = useCallback(
    async (refit: boolean) => {
      if (!currentRead) return
      setRefitAnswered(currentRead.generatedAt)
      if (refit) fitToVoiceover()
      else await keepManualTimingAction(projectId).catch(() => null)
      void refresh()
    },
    [currentRead, fitToVoiceover, projectId, refresh]
  )

  const laneShots = useMemo(() => orderLane(shots), [shots])
  const binnedShots = useMemo(
    () => shots.filter((s) => s.binned_at !== null).sort((a, b) => a.binned_at!.localeCompare(b.binned_at!)),
    [shots]
  )

  // Motion & transitions (B3). The inspect panel stays a Retime-mode action, so entering
  // Motion closes it; leaving Motion drops its selections.
  const setMode = useCallback((next: TimelineMode) => {
    setModeState(next)
    if (next === 'motion') setSelectedShotId(null)
    else {
      setSelectedSegment(null)
      setSelectedJoinShotId(null)
    }
  }, [])
  const selectSegment = useCallback((selection: SegmentSelection | null) => setSelectedSegment(selection), [])
  const selectJoin = useCallback((shotId: string | null) => setSelectedJoinShotId(shotId), [])

  // Word boundaries for the forced-cut rule ride on the voiceover status (projects.
  // voiceover_words, computed when the read settled), placed where the film plays each
  // shot's narration (voice pieces). With no voiceover nothing is forced.
  const liveRead = voiceover.current
  const liveWords = useMemo(
    () => (liveRead ? placeWords(voicePieces(laneShots, liveRead.spans), liveRead.words) : null),
    [liveRead, laneShots]
  )
  // Export (F): the settings, whose motion and transition are the film defaults.
  const [exportSettings, setExportSettings] = useState<StoredExportSettings>(initialExportSettings)
  const savedExportSettings = useRef<StoredExportSettings>(initialExportSettings)
  const [exportSettingError, setExportSettingError] = useState<string | null>(null)
  const filmDefaults = useMemo(() => resolveFilmDefaults(exportSettings), [exportSettings])
  const motions = useMemo(() => resolveMotions(laneShots, filmDefaults.motion), [laneShots, filmDefaults.motion])
  const joins = useMemo(
    () => resolveJoins(laneShots, liveWords, filmDefaults.transition),
    [laneShots, liveWords, filmDefaults.transition]
  )

  // Applied at once and saved at once (a choice, not a slider); a failed save rolls back
  // only if nothing newer has been chosen since.
  const setExportSetting = useCallback(
    async (field: ExportSettingColumn, value: string | null) => {
      if (readOnly) return
      setExportSettings((prev) => ({ ...prev, [field]: value }))
      setExportSettingError(null)
      const result = await saveExportSetting(projectId, field, value).catch(() => ({ success: false }) as const)
      if (result.success) {
        savedExportSettings.current = { ...savedExportSettings.current, [field]: value }
        return
      }
      setExportSettings((prev) => (prev[field] === value ? { ...prev, [field]: savedExportSettings.current[field] } : prev))
      setExportSettingError("That change couldn't be saved, so it was undone. Try again.")
    },
    [projectId, readOnly]
  )

  const setMotion = useCallback(
    (shotId: string, segment: MotionSegment, motion: Motion | null) => {
      const shot = shotsRef.current.find((s) => s.id === shotId)
      if (readOnly || !shot) return
      if (segment === 'b' && shot.split_at === null) return
      const field = segment === 'a' ? 'motion' : 'split_motion'
      if (shot[field] === motion) return
      void commitEdit(field, new Map([[shotId, motion]]), () => saveShotMotion(projectId, shotId, segment, motion))
    },
    [projectId, readOnly, commitEdit]
  )

  // Deleting a split clears its second-segment motion with it. A new or moved split is
  // clamped so each segment keeps the minimum shot length.
  const setSplit = useCallback(
    (shotId: string, splitAt: number | null) => {
      const shot = shotsRef.current.find((s) => s.id === shotId)
      if (readOnly || !shot) return
      if (splitAt === null) {
        if (shot.split_at === null && shot.split_motion === null) return
        setSelectedSegment((prev) => (prev?.shotId === shotId ? { shotId, segment: 'a' } : prev))
        void commitPatches(new Map([[shotId, { split_at: null, split_motion: null }]]), () =>
          saveShotSplit(projectId, shotId, null)
        )
        return
      }
      const at = clampSplit(splitAt, filmSeconds(shot))
      if (at === null || at === shot.split_at) return
      void commitEdit('split_at', new Map([[shotId, at]]), () => saveShotSplit(projectId, shotId, at))
    },
    [projectId, readOnly, commitEdit, commitPatches]
  )

  const setTransition = useCallback(
    (shotId: string, transition: Transition | null) => {
      const shot = shotsRef.current.find((s) => s.id === shotId)
      if (readOnly || !shot || shot.transition_out === transition) return
      void commitEdit('transition_out', new Map([[shotId, transition]]), () => saveTransition(projectId, shotId, transition))
    },
    [projectId, readOnly, commitEdit]
  )

  const statusById = useMemo(() => new Map(data.shots.map((s) => [s.shotId, s])), [data.shots])
  const statusFor = useCallback((shotId: string) => statusById.get(shotId) ?? emptyStatus(shotId), [statusById])

  // Preview & mix (E).
  const [mix, setMix] = useState<MixState>(initialMix)
  const savedMix = useRef<MixState>(initialMix)
  const mixTimers = useRef(new Map<MixColumn, ReturnType<typeof setTimeout>>())
  const [mixError, setMixError] = useState<string | null>(null)
  const mixFailed = "That change couldn't be saved, so it was undone. Try again."

  // Applied at once; saved once the value has been still for the debounce. A failed save
  // rolls back only if nothing newer has been set since.
  const setMixField = useCallback(
    (field: MixColumn, value: MixValue) => {
      if (readOnly) return
      setMix((prev) => ({ ...prev, [field]: value }))
      setMixError(null)
      const timers = mixTimers.current
      clearTimeout(timers.get(field))
      timers.set(
        field,
        setTimeout(async () => {
          timers.delete(field)
          const result = await saveMix(projectId, field, value).catch(() => ({ success: false }) as const)
          if (result.success) {
            savedMix.current = { ...savedMix.current, [field]: value }
            return
          }
          setMix((prev) => (prev[field] === value ? { ...prev, [field]: savedMix.current[field] } : prev))
          setMixError(mixFailed)
        }, MIX_SAVE_DEBOUNCE_MS)
      )
    },
    [projectId, readOnly]
  )

  const resetMix = useCallback(async () => {
    if (readOnly) return
    mixTimers.current.forEach((timer) => clearTimeout(timer))
    mixTimers.current.clear()
    const cleared = { mix_voice_gain_db: null, mix_music_gain_db: null, mix_duck_depth_db: null, mix_duck_bypass: null }
    const before = savedMix.current
    setMix((prev) => ({ ...prev, ...cleared }))
    setMixError(null)
    const result = await resetMixAction(projectId).catch(() => ({ success: false }) as const)
    if (result.success) {
      savedMix.current = { ...savedMix.current, ...cleared }
      return
    }
    setMix((prev) => ({ ...prev, ...before }))
    setMixError(mixFailed)
  }, [projectId, readOnly])

  useLayoutEffect(() => {
    const timers = mixTimers.current
    return () => timers.forEach((timer) => clearTimeout(timer))
  }, [])

  const frameReadiness = useMemo(
    () => readiness(laneShots.map((s) => (statusById.get(s.id) ?? emptyStatus(s.id)).state)),
    [laneShots, statusById]
  )
  const framesReady = frameReadiness.total > 0 && frameReadiness.ready === frameReadiness.total
  // The current music as the film reads it; its mute rides on the music status, like the
  // voiceover's.
  const musicPath = music.current?.path ?? null
  const musicDurationSec = music.current?.durationSec ?? 0
  const musicLoop = music.current?.loop ?? false
  const musicMuted = music.current?.muted ?? false
  const currentMusic = useMemo(
    () => (musicPath ? { path: musicPath, durationSec: musicDurationSec, loop: musicLoop, muted: musicMuted } : null),
    [musicPath, musicDurationSec, musicLoop, musicMuted]
  )
  const film = useMemo(
    () =>
      buildFilmTimeline(
        toFilmInput({
          aspectRatio,
          shots: shots.map((s) => ({ ...s, image_path: statusById.get(s.id)?.imagePath ?? null })),
          read: currentRead,
          music: currentMusic,
          mix,
          settings: exportSettings,
        })
      ),
    [aspectRatio, shots, statusById, currentRead, currentMusic, mix, exportSettings]
  )
  const filmHash = useMemo(() => hashFilm(film), [film])
  const resolvedExport = useMemo(
    () => resolveExportSettings(exportSettings, { hasVoiceover: currentRead !== null, aspectRatio }),
    [exportSettings, currentRead, aspectRatio]
  )

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
            requiredCredits: Number(body?.requiredCredits ?? imagePrice(shotIds.map(statusFor))),
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
    [projectId, readOnly, refresh, setFigures, statusFor]
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
      zoomIndex,
      setZoomIndex,
      retime,
      reorder,
      setBinned,
      restoreScriptOrder,
      voiceover,
      music,
      refreshStatus: refresh,
      voiceoverStaleness: staleness,
      voiceoverOrderDiffers: orderDiffers,
      fitReason,
      fitToVoiceover,
      retimeRange,
      fitClamped,
      mode,
      setMode,
      motions,
      joins,
      selectedSegment,
      selectSegment,
      selectedJoinShotId,
      selectJoin,
      setMotion,
      setSplit,
      setTransition,
      film,
      frameReadiness,
      framesReady,
      mix,
      mixError,
      setMixField,
      resetMix,
      exportSettings,
      resolvedExport,
      setExportSetting,
      exportSettingError,
      filmHash,
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
      zoomIndex,
      retime,
      reorder,
      setBinned,
      restoreScriptOrder,
      voiceover,
      music,
      refresh,
      staleness,
      orderDiffers,
      fitReason,
      fitToVoiceover,
      retimeRange,
      fitClamped,
      mode,
      setMode,
      motions,
      joins,
      selectedSegment,
      selectSegment,
      selectedJoinShotId,
      selectJoin,
      setMotion,
      setSplit,
      setTransition,
      film,
      frameReadiness,
      framesReady,
      mix,
      mixError,
      setMixField,
      resetMix,
      exportSettings,
      resolvedExport,
      setExportSetting,
      exportSettingError,
      filmHash,
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
      <PromptConfirmModal
        content={
          refitAsk
            ? {
                title: 'Refit timing?',
                body: 'The new voiceover has different timing. You retimed shots by hand since the last fit - refitting sets every narrated shot to the new voiceover and replaces those lengths.',
                quote: null,
                confirmLabel: 'Refit',
              }
            : null
        }
        credits={0}
        onConfirm={() => void answerRefit(true)}
        onCancel={() => void answerRefit(false)}
      />
    </StoryboardContext.Provider>
  )
}
